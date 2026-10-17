// CDT_check runs entirely through the OBoard capability gateway. It never
// executes a shell command and never receives the AccessKey Secret plaintext.
// The instance is intended to run on an OBoard interval schedule (for example
// every five minutes). OBoard serializes runs for one plugin instance.

const STATE_KEY = 'monthly_guard_v1'
const ECS_HOST = 'ecs.aliyuncs.com'
const CDT_HOST = 'cdt.aliyuncs.com'
const API_VERSION = '1.0'

function pad(value) {
  return value < 10 ? `0${value}` : String(value)
}

function billingDate(run) {
  const source = run && run.scheduled_at ? new Date(run.scheduled_at) : new Date()
  if (isNaN(source.getTime())) throw new OBoardError('INVALID_ARGUMENT', 'scheduled_at 不是有效时间')
  // scheduled_at is useful for the billing month, but it can be delayed in a
  // busy scheduler. Sign every Alibaba request with the current wall clock.
  const apiDate = new Date()
  const offsets = {
    UTC: 0,
    'Asia/Shanghai': 8,
    'America/Los_Angeles': -8,
  }
  const shifted = new Date(source.getTime() + (offsets[env.BILLING_TIMEZONE] || 0) * 60 * 60 * 1000)
  return {
    source,
    apiDate,
    shifted,
    month: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`,
  }
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function timestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function signedQuery(action, parameters, date) {
  const query = {
    AccessKeyId: env.ACCESS_KEY_ID,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: oboard.crypto.uuid(),
    SignatureVersion: API_VERSION,
    Timestamp: timestamp(date),
    Version: action.indexOf('Cdt') >= 0 ? '2021-08-13' : '2014-05-26',
  }
  Object.keys(parameters || {}).forEach(key => {
    if (parameters[key] !== undefined && parameters[key] !== null && parameters[key] !== '') query[key] = parameters[key]
  })
  const keys = Object.keys(query).sort()
  const canonical = keys.map(key => `${percentEncode(key)}=${percentEncode(query[key])}`).join('&')
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`
  query.Signature = oboard.crypto.hmacSha1(env.ACCESS_KEY_SECRET, stringToSign, { output: 'base64' })
  return query
}

function decodeResponse(response) {
  let payload = response.json
  if (!payload && response.body) {
    try { payload = JSON.parse(response.body) } catch (_) { throw new OBoardError('HTTP_FAILED', '阿里云返回了不可解析的 JSON') }
  }
  if (!response.ok) {
    const code = payload && payload.Code ? payload.Code : `HTTP_${response.status}`
    const message = payload && payload.Message ? payload.Message : `HTTP ${response.status}`
    throw new OBoardError('ALIYUN_API_ERROR', `${code}: ${message}`)
  }
  if (payload && payload.Code) throw new OBoardError('ALIYUN_API_ERROR', `${payload.Code}: ${payload.Message || '请求失败'}`)
  return payload || {}
}

function callAliyun(host, action, parameters, date) {
  const response = oboard.http.request({
    url: `https://${host}/`,
    method: 'POST',
    query: signedQuery(action, parameters, date),
    timeout_ms: 15000,
    max_response_bytes: 256 * 1024,
  })
  return decodeResponse(response)
}

function describeInstance(date) {
  const payload = callAliyun(ECS_HOST, 'DescribeInstances', {
    RegionId: env.REGION_ID,
    InstanceIds: JSON.stringify([env.ECS_INSTANCE_ID]),
    PageSize: 1,
  }, date)
  const instances = payload.Instances && payload.Instances.Instance
  if (!instances || !instances.length) throw new OBoardError('ALIYUN_INSTANCE_NOT_FOUND', 'ECS 实例不存在或不在该地域')
  return instances[0]
}

function queryTraffic(date) {
  const payload = callAliyun(CDT_HOST, 'ListCdtInternetTraffic', {
    BusinessRegionId: env.REGION_ID,
  }, date)
  const details = payload.TrafficDetails
  if (!Array.isArray(details) || details.length === 0) throw new OBoardError('ALIYUN_TRAFFIC_EMPTY', 'CDT 未返回 TrafficDetails，已停止自动开关机决策')
  let bytes = 0
  details.forEach(detail => {
    const value = Number(detail && detail.Traffic)
    if (isFinite(value) && value >= 0) bytes += value
  })
  return bytes
}

function requestInstanceAction(action, date) {
  return callAliyun(ECS_HOST, action, {
    RegionId: env.REGION_ID,
    InstanceId: env.ECS_INSTANCE_ID,
    ClientToken: oboard.crypto.uuid(),
  }, date)
}

function readGuard(month) {
  const entry = oboard.state.get(STATE_KEY)
  if (!entry.exists || !entry.value || entry.value.month !== month) {
    return { entry, value: { month, threshold_reached: false, locked: false, last_action: 'none' } }
  }
  return { entry, value: entry.value }
}

function saveGuard(guard) {
  const expected = guard.entry && guard.entry.exists ? guard.entry.version : 0
  return oboard.state.compareAndSwap(STATE_KEY, expected, guard.value)
}

function notifyOnce(guard, action, body) {
  if (!env.NOTIFY || guard.value.last_notification === action) return
  try {
    oboard.notifications.send({ title: 'OBoard CDT 流量检测与保活', body })
    guard.value.last_notification = action
  } catch (error) {
    log.warn('通知未发送', error.code || error.message || String(error))
  }
}

function render(result) {
  const tone = result.locked ? 'danger' : (result.traffic_gb >= Number(env.TRAFFIC_LIMIT_GB) ? 'warning' : 'success')
  const statusText = result.locked ? '本月已锁定，不再自动开机' : result.status
  oboard.ui.publish({
    page: 'status',
    document: {
      title: 'CDT 流量检测与保活',
      body: [
        { type: 'badge', text: statusText, tone },
        { type: 'metric', label: '本月 CDT 流量', value: `${result.traffic_gb.toFixed(2)} GiB`, tone },
        { type: 'metric', label: '关机阈值', value: `${Number(env.TRAFFIC_LIMIT_GB).toFixed(2)} GiB` },
        { type: 'text', text: `地域 ${env.REGION_ID} · 实例 ${env.ECS_INSTANCE_ID} · ${result.month}` },
        { type: 'text', text: result.action_message },
        { type: 'button', action: 'check_now', label: '立即检查' },
      ],
    },
  })
}

function main(run) {
  const clock = billingDate(run)
  const guard = readGuard(clock.month)
  let instance
  let bytes
  try {
    // Traffic is queried before any start decision. A failed or empty usage
    // response therefore fails closed and cannot wake an instance by mistake.
    bytes = queryTraffic(clock.apiDate)
    instance = describeInstance(clock.apiDate)
    const trafficGb = bytes / (1024 * 1024 * 1024)
    const threshold = trafficGb >= Number(env.TRAFFIC_LIMIT_GB)
    const status = String(instance.Status || 'Unknown')
    let message = `ECS 状态：${status}`

    if (threshold) {
      guard.value.threshold_reached = true
      guard.value.locked = true
      if (status === 'Running' || status === 'Starting') {
        try {
          requestInstanceAction('StopInstance', clock.apiDate)
          guard.value.last_action = 'stop_requested'
          message = `流量达到阈值，已请求关机（原状态 ${status}）`
          notifyOnce(guard, `stop:${clock.month}`, `${env.ECS_INSTANCE_ID} 本月流量 ${trafficGb.toFixed(2)} 已达到阈值，已请求关机并锁定。`)
        } catch (error) {
          guard.value.last_action = 'stop_pending'
          message = `流量达到阈值，但关机请求失败：${error.code || error.message}`
          notifyOnce(guard, `stop_failed:${clock.month}`, message)
        }
      } else if (status === 'Stopped') {
        guard.value.last_action = 'locked'
        message = '流量达到阈值，实例已关机，本月保持锁定'
        notifyOnce(guard, `locked:${clock.month}`, `${env.ECS_INSTANCE_ID} 已关机，本月不再自动开机。`)
      } else {
        guard.value.last_action = 'locked'
        message = `流量达到阈值，当前状态 ${status}，本月保持锁定`
      }
    } else if (guard.value.locked || guard.value.threshold_reached) {
      message = `本月已锁定，当前 ECS 状态 ${status}，不会自动开机`
    } else if (status === 'Stopped') {
      try {
        requestInstanceAction('StartInstance', clock.apiDate)
        guard.value.last_action = 'start_requested'
        message = '实例未运行，已请求开机'
        notifyOnce(guard, `start:${clock.month}`, `${env.ECS_INSTANCE_ID} 当前未运行，已请求开机。`)
      } catch (error) {
        guard.value.last_action = 'start_failed'
        message = `实例未运行，但开机请求失败：${error.code || error.message}`
        notifyOnce(guard, `start_failed:${clock.month}`, message)
      }
    } else {
      message = `ECS 状态：${status}，无需开机操作`
    }

    guard.value.last_status = status
    guard.value.last_bytes = bytes
    guard.value.last_traffic_gb = trafficGb
    guard.value.last_checked_at = clock.apiDate.toISOString()
    saveGuard(guard)
    const result = { month: clock.month, site: env.CLOUD_SITE, status, locked: !!guard.value.locked, traffic_gb: trafficGb, action_message: message }
    render(result)
    log.info(message, `traffic=${trafficGb.toFixed(2)}`)
    return result
  } catch (error) {
    const message = `检查失败，已采取安全策略：${error.code || error.message || String(error)}`
    guard.value.last_action = 'error'
    guard.value.last_error = message
    try { saveGuard(guard) } catch (stateError) { log.error('状态保存失败', stateError.code || stateError.message || String(stateError)) }
    try { oboard.ui.publish({ page: 'status', document: { title: 'CDT 流量检测与保活', body: [{ type: 'badge', text: '检查失败', tone: 'danger' }, { type: 'text', text: message }, { type: 'button', action: 'check_now', label: '重试检查' }] } }) } catch (uiError) { log.warn('状态页发布失败', uiError.code || uiError.message || String(uiError)) }
    throw error
  }
}
