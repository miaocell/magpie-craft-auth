# 致谢

这个插件的协议细节不是文档里读出来的，是对着网页抓包和 bundle 一点点拆出来的。感谢社区里愿意把现象、日志和猜测都写出来的人——很多结论是从别人的提问里才想到要去验证的。

如果漏了谁，或者下面的描述不准确，欢迎指出。

## 协议与逆向

| 来源 | 内容 |
| --- | --- |
| `craft.qq.com` 网页 bundle | `X-Client-Version` / `X-Client-Type` 这两个头的名字和注入方式是从 `index-*.js` 里读出来的。`hs()` 函数里 `a.set(is, zn)`、`a.set(es, os)` 那两行直接决定了缺头就回 10001，而不是 body 的问题 |
| 站点自身的 XHR | `POST /api/chathost/send` 的 body 结构、`inputs.model_selection` 的嵌套形状、`user_message_id` 用 uuid，都是照着网页真实请求抄的 |
| `model-options` 接口 | 模型清单和「限时免费」标签直接来自这个接口，不是前端写死的表——所以站点下线 GLM-5.4 时插件不用改代码 |
| SSE 事件流 | `event:message` 的 `answer` 是增量、`agent_event` 是内部元数据、`model_queue` 带 `state` 和 `ahead`，靠逐个事件打出来对齐的 |

## 工具与平台

| 项目 | 说明 |
| --- | --- |
| [magpie](https://usemagpie.ai) | 插件宿主。`provider.models`、`auth.usage`、`X-Magpie-Refused` 这些约定的行为是照着它的源码确认的 |
| [magpie-doubao-work-auth](https://github.com/miaocell/magpie-doubao-work-auth) | 同一位作者的豆包插件。这个仓库的目录结构、发布约定（`VERSIONING.md`、`registry-entry.json`）、README 的组织方式都参照了它 |

## 反馈

还没有公开的 issue。用下来遇到问题，现象、报错码、`requestId` 这三样一起贴出来最好查——游点灵的错误响应里带 `requestId`，服务端能据此定位到具体那一次请求。
