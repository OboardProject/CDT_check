# CDT_check 插件说明

`CDT_check` 是一个 OBoard `oboard-js` 插件。它按实例计划执行以下闭环：

1. 通过阿里云 ECS OpenAPI 查询 ECS 实例真实电源状态。
2. 通过 CDT `ListCdtInternetTraffic` 查询当前业务地域的累计流量。
3. 只有在流量查询成功且本月尚未触发阈值时，实例处于 `Stopped` 才请求 `StartInstance`。
4. 流量达到阈值时请求 `StopInstance`，并把“本月已锁定”写入 OBoard 私有状态；锁定后即使实例被手工开机，插件也不会再次自动开机。
5. 账单月进入下月后自动开始新的周期。状态使用配置的固定账单时区，默认 UTC+8。

插件不包含 Shell、Python、Telegram、定时器、文件写入或阿里云 SDK。AK/SK 通过 OBoard 的环境字段保存，其中 Secret 只以 `SecretRef` 参与 RPC HMAC-SHA1 签名。阿里云 API 返回错误、空的 `TrafficDetails` 或状态查询失败时，插件不会执行自动开机；达到阈值后的关机失败会保留锁定并在下一次计划运行中继续尝试。

## 使用步骤

1. 在 OBoard 安装插件，创建一个实例并填写 `REGION_ID`、`BUSINESS_REGION_ID`、`ECS_INSTANCE_ID`、流量阈值和阿里云 RAM 用户的 AccessKey。
2. RAM 用户只授予该地域、该实例所需的 `ecs:DescribeInstances`、`ecs:StartInstance`、`ecs:StopInstance` 和 CDT 流量读取权限。不要把主账号 AccessKey 写入插件。
3. 给实例授权后启用它，并在 OBoard 中创建 interval 计划。建议每 5 分钟运行一次；计划不是插件代码里的计时器。
4. 为 `notifications.send` 授权管理员通知渠道（可选）。

`CLOUD_SITE` 只标记中国站或国际站。ECS 与 CDT 的 OpenAPI 请求都使用官方公共端点，国内/国际的实际区别由 `REGION_ID` 与 `BUSINESS_REGION_ID` 决定；例如 `cn-hongkong`、`cn-shanghai`、`ap-southeast-1`。

## 官方接口参考

- [ECS DescribeInstances](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-describeinstances)
- [ECS StartInstance](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-startinstance)
- [ECS StopInstance](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-stopinstance)
- [CDT ListCdtInternetTraffic](https://help.aliyun.com/zh/cdt/developer-reference/api-cdt-2021-08-13-listcdtinternettraffic)
- [阿里云 RPC API 请求签名](https://help.aliyun.com/zh/sdk/product-overview/signature-method)
