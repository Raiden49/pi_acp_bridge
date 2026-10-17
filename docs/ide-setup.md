# 补充客户端配置

接入步骤见 [README](../README.md#connect-your-ide)：CLion / PyCharm 的 Air in IDEs 使用本地 Registry 安装；独立 Air Desktop 使用 `acp.json`。

## Zed

在 Zed 设置的 `agent_servers` 中使用 README 的同一代理条目，并在条目中增加 `"type": "custom"`。

## Air in IDEs 本地 Registry

仅用于支持 `air.acp.registry.path` 的 Air in IDEs；本机核查版本为 CLion 2026.2 / Air 插件 262.8665.497。其他版本须确认支持该键，**不适用于独立 Air Desktop**。

脚本默认获取完整公共目录，保留原条目与图标，追加 Pi Bridge，并生成启动器 ZIP。下载失败时停止，不写出单代理目录。IDE 仍通过本地覆盖读取这个合并快照，并非实时叠加公共源；重新运行脚本才能刷新公共条目。已安装代理不会因此被卸载。

### 配置

1. 按 README 构建后，在仓库根目录用选定的 Node 运行：

   ```sh
   node scripts/create-local-registry.mjs
   ```

   脚本下载公共清单并生成 `.scratch/local-registry/` 下的文件，不修改 IDE、不安装代理。记录输出的 `registry.json` 绝对路径，保留生成目录。

2. **完全退出 IDE 并备份配置文件**。macOS 的 CLion 2026.2 使用：

   ```text
   ~/Library/Application Support/JetBrains/CLion2026.2/options/ide.general.xml
   ```

   其他产品/版本使用自己的配置目录；自定义过配置目录时以实际位置为准。

3. 在已有 `<component name="Registry">` 内添加或更新以下 entry；若无该 component，在根 `<application>` 内创建。**不要覆盖其他内容或创建重复项。**

   ```xml
   <entry key="air.acp.registry.path"
          value="/absolute/path/to/pi_acp_bridge/.scratch/local-registry/registry.json"
          source="USER" />
   ```

   value 是第 1 步的绝对文件路径，不是 `file://` URL；特殊字符按 XML 规则转义。

   `ide.general.xml` 保存的是 **IDE 内部设置**，不是 ACP 代理清单。这里仅覆盖目录来源；真正的代理条目、图标和安装包信息在生成的 `registry.json` 中。默认公共目录不必出现在这个 XML 中。

4. 重启 IDE，在 Air 代理目录安装 **Pi Bridge**，再新建聊天。仅修改来源不会自动安装代理。不要同时保留另一条指向同一 bridge 的直接配置，以免混淆。

### 保留目录条目、更新与移除

显示名已去掉 `(Local)`；内部 ID 保持 `pi-acp-bridge-local`，避免把已安装代理变成另一个身份。旧安装若仍显示旧名称，在目录刷新后检查更新；不要通过编辑安装记录来强行改名。

- 离线或使用自定义目录时，可传入已有的 version 1 目录快照，替代公共下载：
  `node scripts/create-local-registry.mjs /absolute/path/to/base-registry.json`。这是快照合并，不会实时跟随公共目录更新。
- 普通代码更新只需重建 bundle 并重启代理；仓库或 Node 路径改变时，重新生成并重新安装启动器。每台机器分别生成。
- 移除时先在代理管理器卸载 **Pi Bridge**，退出 IDE，恢复该 entry 原值；原先没有则只删除该 entry。重启后可删除生成目录。
- 直接 ACP 配置的移除只需删除对应 `agent_servers` 条目。两种方式都不需要删除 Pi 认证或聊天历史。
