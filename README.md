# CDT_check

OBoard 插件：通过阿里云 ECS/CDT API 自动管理实例开关机。

## 功能

- 定时读取 ECS 实例状态和 CDT 本月流量。
- 实例未运行且未达到阈值时自动开机。
- 流量达到阈值后自动关机，并锁定到下一个账单月。
- 在 OBoard 插件页面显示状态，可选发送管理员通知。

## 使用

在 OBoard 安装插件并创建实例，填写地域、ECS 实例 ID、流量阈值和阿里云 RAM AccessKey。地域同时用于 ECS 和 CDT，流量单位固定为 GiB（1024³ 字节）。然后授权插件能力，启用实例，并创建 interval 计划（建议每 5 分钟执行一次）。

`ACCESS_KEY_SECRET` 通过 OBoard SecretRef 保存。建议使用仅包含 `ecs:DescribeInstances`、`ecs:StartInstance`、`ecs:StopInstance` 和 CDT 流量读取权限的 RAM 用户。

国内站和国际站使用同一套 OpenAPI，按实际情况填写 `REGION_ID`；插件会自动将它作为 CDT 的 `BusinessRegionId`。

详细配置和官方 API 链接见 [PLUGIN.md](PLUGIN.md)。
