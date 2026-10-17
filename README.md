# LittleWhiteMemory

基于 [LittleWhiteBox（小白X）](https://github.com/RT15548/LittleWhiteBox) 3.1.3 的剧情记忆部分制作，面向 **TauriTavern**，非原作者官方版本。保留剧情总结、L0 锚点、L1/L2 向量记忆、检索注入及相应管理面板；其他小白X功能不包含在内。总结生成暂只支持 OpenAI 兼容接口（向量嵌入和重排仍使用面板各自配置的提供方）。

这是**独立插件**。设置、聊天 metadata、向量索引、extension store 和服务器备份使用新身份；**插件运行时不会自动读取、迁移或清理原 LittleWhiteBox 的数据**。同时安装旧插件时两个插件都可能注入剧情记忆，建议在旧插件中关闭剧情总结。

将本目录整体放入 TauriTavern 的第三方扩展目录后重启，从消息输入框旁的魔棒菜单选择「剧情记忆」打开面板；扩展设置中可关闭该功能。`src/` 与 `libs/` 为浏览器运行时依赖（含 WASM），无需构建或额外打包。

当前 L0 向量在 extension store 有持久副本；L1/L2 向量仍只有 WebView IndexedDB 缓存，清理 WebView 数据后须重新构建。魔棒菜单入口及面板在桌面/移动端仍需真实 WebView 验收。

## 许可证

基于原项目 Apache License 2.0 及其附加署名要求；Copyright 2025 biex。见 [LICENSE](docs/LICENSE.md)、[COPYRIGHT](docs/COPYRIGHT)、[NOTICE](docs/NOTICE)。
