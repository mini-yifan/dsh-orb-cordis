# 打包与三端部署手册

> 适用仓库：`dsh-mesh`、`dsh-orb-cordis`、`dsh-orb-android`（三者合起来构成 DSH Orb）
> 建立时间：2026-11-20，依据当日一轮真实打包与四端部署的实测记录
> 面向：任何要重新打包、升级插件版本、或把改动部署到 Mac / Windows / 安卓的 Agent

这份手册只讲**怎么做、按什么顺序、哪里会炸**。设计取舍见 `14`–`19`，手机侧细节见 `dsh-orb-android/docs/phone-device-testing.md`，安卓发版规则见 `dsh-orb-android/docs/release.md`。

---

## 0. 先读：三个仓库的分工

| 仓库 | 是什么 | 产物 |
|---|---|---|
| `dsh-mesh` | 中继服务器 + 每台设备都装的 `@dsh-mesh/plugin` | 服务器镜像；`packages/mesh-plugin/dist-phone/*.tgz` |
| `dsh-orb-cordis` | 电脑端悬浮球（Electron helper + host 插件 + 设置页 + 互联窗口） | `dsh-orb-<版本>.tgz`（唯一可安装的电脑插件包） |
| `dsh-orb-android` | 手机 App（Flutter）+ 手机端 Linux runtime | `dist/dsh-orb-<版本>-arm64.apk` |

**关键：插件 tgz 是唯一的跨端载体。** `dsh-mesh` 改完之后，必须把 tgz 分别喂给另外两端，否则改动不会到达用户：

```text
dsh-mesh/packages/mesh-plugin/dist-phone/dsh-mesh-plugin-X.Y.Z.tgz
   ├─→ dsh-orb-cordis/packages/bundle/vendor/mesh/     （sync-mesh.mjs 解包）
   └─→ dsh-orb-android/runtime/out/.../rootfs-*.tar.xz （repack-rootfs.py 注入）
```

**服务器本身通常不需要动。** 中继是 `dsh-mesh/apps/server`；插件的行为改动（工具、会话、UI）不涉及它。只有 `apps/server` 有改动时才需要重新部署服务器。

---

## 1. 一次完整升级的顺序

改动进入线上要跨三个仓库，**顺序不能换**：插件是被依赖者，两端是消费者。

```text
① dsh-mesh      改插件 → 构建 → pack:phone → 提交 tgz
② dsh-orb-cordis sync-mesh（拉新 tgz）→ build → pack → 提交
③ dsh-orb-android 重打 runtime（注入新 tgz）→ 打 APK → release_assets
④ 部署：服务器（仅当 apps/server 变了）/ Mac / Windows / 安卓
⑤ 验证：三端在线 + 各自本地功能 + 跨设备派任务
```

每一步的「怎么确认成功」写在各节末尾。**没确认就进下一步**是这套流程最常见的错误来源。

---

## 2. ① dsh-mesh：插件版本与打包

### 2.1 改版本号

三个文件里的版本必须一致：

```sh
cd dsh-mesh
# packages/mesh-plugin/package.json      "version"
# packages/mesh-plugin/dsh-plugin.json   "version"
```

### 2.2 构建并打 tgz

```sh
pnpm --filter @dsh-mesh/mesh test          # 先跑测试
pnpm --filter @dsh-mesh/mesh build         # src -> dist
cd packages/mesh-plugin
../../node_modules/.bin/tsdown --config tsdown.config.ts   # src -> bundle/
pnpm pack:phone                            # bundle -> dist-phone/dsh-mesh-plugin-X.Y.Z.tgz
```

`pack:phone`（`scripts/pack-phone.py`）产出**自包含、可复现**的 tgz：固定 mtime/uid/gid、成员排序、gzip mtime=0，同一内容 sha256 稳定。手机 runtime 靠这个 sha 认版本。

**确认**：

```sh
shasum -a 256 packages/mesh-plugin/dist-phone/dsh-mesh-plugin-X.Y.Z.tgz
# tgz 里必须有 bundle 的全部入口
tar -tzf packages/mesh-plugin/dist-phone/dsh-mesh-plugin-X.Y.Z.tgz | grep -E 'lib/(index|device-agent|return-files)\.mjs'
```

### 2.3 tgz 必须入库

`dist-phone/*.tgz` 是**提交进仓库**的（不是构建产物），理由见 `packages/mesh-plugin/README.md`：另外两个仓库都不构建它，tgz 是唯一实际发布的东西；设备也靠版本号区分「修好的插件」和「坏的插件」。

```sh
git add packages/mesh-plugin/dist-phone/dsh-mesh-plugin-X.Y.Z.tgz \
        packages/mesh-plugin/package.json packages/mesh-plugin/dsh-plugin.json
```

### 2.4 服务器要不要重新部署？

```sh
git diff <上次部署的提交>..HEAD --stat -- apps/ packages/protocol packages/client-core packages/plugin
```

- **空** → 服务器不用动。
- **非空** → 按 `dsh-mesh/docs/server-accounts.md` 部署（当前生产：`dshorb.top`，compose 在 `/opt/dsh-mesh-new/deploy`）。

服务器部署的三个历史坑（都已在文档里）：内存不足要先 `swapon`；compose 必须同时发布 80 和 443 否则 Let's Encrypt 签不出证书；轻量服务器的防火墙在独立标签页而不是「安全组」。

---

## 3. ② dsh-orb-cordis：电脑插件包

### 3.1 先把新插件拉进来（最容易漏的一步）

```sh
cd dsh-orb-cordis/packages/bundle
node scripts/sync-mesh.mjs
```

它默认取 `../../../dsh-mesh/packages/mesh-plugin/dist-phone/` 里**版本号最大**的 tgz（按版本排序，不是字符串排序），解包到 `packages/bundle/vendor/mesh/`。

也可以显式指定：

```sh
DSH_MESH_TARBALL=/path/to/plugin.tgz node scripts/sync-mesh.mjs
DSH_MESH_BUNDLE=/path/to/bundle-dir  node scripts/sync-mesh.mjs
```

> **跳过这步的后果**：`assemble.mjs` 会把**旧** vendor 打进电脑插件包，新功能完全不生效，而且没有任何报错。这是本轮实际踩到的坑——`vendor/mesh` 停在 0.1.5，而 `dsh-mesh` 已经是 0.1.6。

**确认**（把 `device_agent_devices` 换成你这次新增的标识）：

```sh
ls -la packages/bundle/vendor/mesh/
grep -c "device_agent_devices" packages/bundle/vendor/mesh/device-agent.mjs   # 非 0
```

### 3.2 构建

```sh
cd ../..            # 回到 dsh-orb-cordis 根目录
pnpm build          # 各包 tsdown + bundle/scripts/assemble.mjs
```

`assemble.mjs` 把 `client-settings` / `host` / `computer-use` / `desktop` / `helper` / `voice` / `vendor/mesh` 全部装进 `packages/bundle/`（`lib/`、`client.js`、`dist/`）。它先写到临时目录再原子替换，所以不要在它运行时读 `dist/`。

**确认**：

```sh
grep -c "device_agent_devices" packages/bundle/dist/mesh/device-agent.mjs   # 新插件进来了
grep -c "device_agent_devices" packages/bundle/cordis.patch.yml             # prompt 路由也更新了
```

`cordis.patch.yml` 是**提示词层**：它决定电脑端 Agent 什么时候走 `device_agent`。插件有工具但提示词没提，Agent 就不会用——两者必须一起改。

### 3.3 打包

```sh
node packages/bundle/scripts/pack.mjs --version 0.2.7
# -> dsh-orb-0.2.7.tgz
```

- `packages/bundle/package.json` 里的 `version` 长期停在旧值（现在 `0.2.1`），**实际版本由 `--version` 覆盖**；不传就用清单里的，会打出旧版本号。
- 打包会把 `koffi`、`zod`、语音引擎、各平台 prebuild 复制进 tgz 自己的 `node_modules`（约 88 MB）。安装时不需要联网。

**确认**：

```sh
tar -xzOf dsh-orb-0.2.7.tgz package/package.json | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])"
tar -xzOf dsh-orb-0.2.7.tgz package/dist/mesh/device-agent.mjs | grep -c device_agent_devices
tar -tzf dsh-orb-0.2.7.tgz | grep -c "package/node_modules/"      # runtime 依赖在里面
```

### 3.4 跑测试

```sh
pnpm test
```

> 已知既有失败：`packages/bundle/tests/install.test.mjs` 有 2 例断言 patch 导出列表时少了 `dsh-orb/desktop`（`35ba280` 引入），与本轮改动无关。742/743 通过即正常。

---

## 4. ③ dsh-orb-android：手机安装包

完整规则见 `dsh-orb-android/docs/release.md`，这里只列跨仓库相关的部分。

### 4.1 什么时候要重打 runtime

`runtime/out/` 是 Linux rootfs（PRoot + Node + DSH + 桥接 + mesh 插件），**被 gitignore、不入库**。

| 变了什么 | 重打 runtime？ |
|---|---|
| Dart / Kotlin / UI / l10n | 不要 |
| `runtime/bridge/dsh-go-bridge/` | 要 |
| **mesh 插件版本** | **要**（插件版本计入 `runtimeVersion`） |
| DSH / Node / patches | 要 |

### 4.2 注入新插件

```sh
cd dsh-orb-android
MESH_TGZ=../dsh-mesh/packages/mesh-plugin/dist-phone/dsh-mesh-plugin-X.Y.Z.tgz
MESH_SHA=$(shasum -a 256 "$MESH_TGZ" | cut -d' ' -f1)
rm -rf /tmp/plugpkg && mkdir -p /tmp/plugpkg && tar -xzf "$MESH_TGZ" -C /tmp/plugpkg

# 生成 overlay
RUNTIME_PLUGIN_CHECK=1 \
DSH_PLUGIN_NAME='@dsh-mesh/plugin' DSH_PLUGIN_VERSION='X.Y.Z' \
DSH_PLUGIN_URL="file://$MESH_TGZ" DSH_PLUGIN_ENTRY='lib/index.mjs' \
DSH_PLUGIN_CONFIG='{"platform":"android","incomingPreset":"phone-background","defaultServer":"https://dshorb.top"}' \
bash runtime/build-runtime.sh arm64-v8a

# 重打 rootfs
python3 -I runtime/lib/repack-rootfs.py \
  --rootfs runtime/out/arm64-v8a/assets/runtime/rootfs-arm64-v8a.tar.xz \
  --plugin-dir /tmp/plugpkg/package \
  --overlay runtime/.work/plugin-check/dsh-web.patch.yml \
  --version "r15-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5-meshX.Y.Z-${MESH_SHA:0:12}-presets<N>" \
  --manifest runtime/out/arm64-v8a/assets/runtime/manifest.json \
  --plugin-name '@dsh-mesh/plugin' --plugin-version X.Y.Z \
  --plugin-sha256 "$MESH_SHA" \
  --rootfs-path '/opt/dsh-go/plugins/@dsh-mesh/plugin' \
  --config '{"platform":"android","incomingPreset":"phone-background","defaultServer":"https://dshorb.top"}'
```

`presets<N>` 每改一次 overlay 就 +1，否则 App 不会触发升级。单次约 6 分钟。

### 4.3 打 APK 并生成资产

```sh
tooling/build-apk.sh -f arm64
cd tooling && python3 release_assets.py --notes /tmp/notes.md --delta-from 0
```

- 先升 `app/pubspec.yaml` 的版本名，并让 `docs/guide/README.md` 的 `> dsh-go X.Y.Z` 跟着变，否则 `guide_sync.py --check` 会拦。
- `--delta-from 0`：没有历史 Release 时必须加，否则脚本去 GitHub 拉旧包会失败。
- 必须在 `tooling/` 下跑；`python3 -I tooling/release_assets.py` 会 `ModuleNotFoundError: apk_delta`。

**确认**：

```sh
aapt2 dump badging dist/dsh-orb-X.Y.Z-arm64.apk | head -1        # 包名 / versionName / versionCode
unzip -p dist/dsh-orb-X.Y.Z-arm64.apk assets/runtime/manifest.json | head -20
apksigner verify -v --min-sdk-version 21 --print-certs dist/dsh-orb-X.Y.Z-arm64.apk
```

---

## 5. ④ 部署到 Mac

Mac 上 `~/.dsh/profiles/desktop/node_modules/dsh-orb/` 是**已安装副本**（来自 tgz），不是仓库链接。改代码后有两种生效方式。

### 5.1 方式 A：手工同步文件（快，适合小改）

按 `docs/04-addenda.md` 第 14 节的做法：

```sh
cd dsh-orb-cordis
P=~/.dsh/profiles/desktop/node_modules/dsh-orb
BK=~/.dsh/dsh-orb-installed-backup-$(date +%Y%m%d-%H%M%S)

# 先备份要覆盖的文件
mkdir -p "$BK/helper-assets"
cp -a "$P/dist/host/index.js"        "$BK/"
cp -a "$P/dist/mesh/index.mjs"       "$BK/"
cp -a "$P/dist/helper/lib/main.js"   "$BK/"
cp -a "$P/dist/helper/assets/"*.js   "$P/dist/helper/assets/"*.css  "$BK/helper-assets/" 2>/dev/null

# 就位：cp 到临时名再 mv，避免写穿 pnpm 硬链接
put() { cp "$1" "$2.tmp.$$" && mv -f "$2.tmp.$$" "$2"; }
put packages/bundle/dist/host/index.js          "$P/dist/host/index.js"
put packages/bundle/dist/mesh/index.mjs         "$P/dist/mesh/index.mjs"
put packages/bundle/dist/helper/lib/main.js     "$P/dist/helper/lib/main.js"
put packages/bundle/client.js                   "$P/client.js"

# 确认整棵树没有差异
diff -rq packages/bundle/dist "$P/dist" && echo "dist 完全一致"
```

需要同步哪些文件，一律以 `diff -rq packages/bundle/dist "$P/dist"` 的输出为准，不要凭记忆列清单。

**重启**（host 与 helper 都在进程启动时加载）：

```sh
kill -TERM $(pgrep -f "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness$" | head -1)
sleep 10
open -a "/Applications/DeepSeek Harness.app"
sleep 30
ps aux | grep -c "[D]eepSeek Harness"     # 6~9 个进程都正常（渲染/GPU/工具各若干）
pgrep -f dsh-desktop-host | head -1        # 新的 host pid
```

> `osascript -e 'tell application "DeepSeek Harness" to quit'` 在这台机器上会报「应用程序没有运行」，用 `kill -TERM` 主进程。

### 5.2 方式 B：用 tgz 重装（干净，推荐发版后）

```sh
cd dsh-orb-cordis
# profile 的 package.json 里 dsh-orb 指向一个 tgz；换成新的再 install
# 这是 Electron 独占 profile，CLI 操作会被拒——要在 App 内插件页操作，或先退出 App
```

发版形态下用这条；日常迭代用方式 A 更快。

### 5.3 确认生效

```sh
# 文件层面
grep -c "openMeshWindow\|createSession" ~/.dsh/profiles/desktop/node_modules/dsh-orb/dist/host/index.js
# 进程层面：helper 启动时间应晚于文件落位时间
ps -o pid,lstart,command -p $(pgrep -f dsh-orb-helper) | cut -c1-80
# 互联状态：至少要有 Host 1 条 + Client 若干条连到服务器
lsof -nP -iTCP 2>/dev/null | grep -c "<relay-host>:443"   # 通常 3~4
```

---

## 6. ④ 部署到 Windows

Windows 那台通过 SSH 访问（见项目根目录的 `windows-harness-remote/README.md`），profile 在 `C:\Users\<user>\.dsh\profiles\desktop`。下文用 `$WIN` 代表 `ssh <user>@<windows-host>`。

### 6.1 传文件并对齐哈希

```sh
cd dsh-orb-cordis
STAGE=/tmp/dsh-win-sync; rm -rf $STAGE; mkdir -p $STAGE
cp packages/bundle/dist/host/index.js       $STAGE/host-index.js
cp packages/bundle/dist/mesh/index.mjs      $STAGE/mesh-index.mjs
cp packages/bundle/dist/helper/lib/main.js  $STAGE/helper-main.js
cp packages/bundle/dist/helper/assets/icons.js $STAGE/
cp packages/bundle/dist/helper/assets/mesh.js  $STAGE/
cp packages/bundle/dist/helper/assets/mesh.css $STAGE/
scp $STAGE/* $WIN:C:/Users/<user>/AppData/Local/Temp/
```

**先备份**，再落位。落位脚本里有三个必须注意的点：

```powershell
# 1) 用 Join-Path 拼路径；字符串拼接会漏掉反斜杠分隔符
# 2) 每个文件都要回读 SHA256 前 16 位，与 Mac 侧 shasum 对照
# 3) 计划任务必须用 SID，不能拼 WORKGROUP\<user>
$p = "C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-orb"
Copy-Item (Join-Path $src "host-index.js") (Join-Path $p "dist\host\index.js") -Force
# ... 其余文件同理
@(...) | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash.Substring(0,16) + "  " + (Split-Path $_ -Leaf) }
```

六个哈希要与 Mac 上 `shasum -a 256` 的结果逐一相同。

### 6.2 重启（必须投递到交互式会话）

SSH 落在 **session 0**，直接启动 exe 会立刻退出。用计划任务：

```powershell
$sid  = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$exe  = "C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$name = "dsh-restart-temp"
$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory (Split-Path $exe)
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Force | Out-Null
Get-Process | Where-Object ProcessName -eq 'DeepSeek Harness' | Stop-Process -Force
Start-Sleep -Seconds 4
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 30
Unregister-ScheduledTask -TaskName $name -Confirm:$false
Get-Process | Where-Object ProcessName -eq 'DeepSeek Harness' | Select Id,SessionId,StartTime
```

**确认**：6 个进程全部 `SessionId = 1`。

### 6.3 Windows 专属的三个坑

1. **PowerShell 5.1 按 GBK 解码无 BOM 的 .ps1**：脚本里只要有中文就解析失败。含非 ASCII 必须存成 UTF-8 with BOM。
2. **`$env:USERDOMAIN` 是 `WORKGROUP`**：用它拼 `UserId` 注册计划任务报 `0x80070534`，必须用 SID（`[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`）。
3. **`dist\desktop\native\win32-x64\` 必须同时有 CLI 和 DLL**：仓库里默认只有 `agent-desktop.exe`，`agent_desktop_ffi.dll` 要单独补，否则 AX 路径整体失效。

另外：`--profile desktop` 被 Electron 独占，验证配置合成要复制 profile 到临时名再 `--dump-config`。端口每次重启都变，用 `Get-NetTCPConnection` 按 host pid 查。

---

## 7. ④ 部署到安卓

```sh
adb devices                                    # 状态必须是 device
adb install -r dist/dsh-orb-X.Y.Z-arm64.apk    # 签名一致才能覆盖
adb shell monkey -p top.dshorb.app -c android.intent.category.LAUNCHER 1
sleep 40
adb shell ps -A | grep -E "dshorb|proot|node"
```

App 自己解压新 rootfs（原地升级）。首启可能要等几十秒。

**确认**：App 内「设置 → 关于」显示新版本；本机引擎「运行中」；`libproot.so` 与 `node` 进程存在。

> release 包不能 `run-as`（不可调试）。要核对 runtime 版本就读 APK 里的 `assets/runtime/manifest.json`，不要用 `run-as ... cat files/runtime/rootfs.version`。

### 7.1 手机上做 UI 验证：坐标怎么取

Flutter 页面**不暴露文本节点给普通 uiautomator**，但 `uiautomator dump` 能拿到 `text` / `content-desc`：

```sh
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml /tmp/ui.xml
# 从 dump 里读 bounds="[x1,y1][x2,y2]"，中心点就是 tap 坐标
adb shell input tap <cx> <cy>
```

四条实测经验：

1. **键盘弹出后布局会位移**，发送按钮的坐标会变——每次点击前重新 dump，不要复用旧坐标。
2. `uiautomator dump` 偶尔产出**没有文本**的树（Flutter 半渲染状态）。此时改用 `screencap` 对照，或重新 dump。
3. `screencap` 的 PNG 尺寸与 `input tap` 是同一套坐标系（这台机器 1440×3120），不需要换算。
4. 长按、拖动、语音等手势对原生悬浮窗不稳定，仍建议手动。

---

## 8. ⑤ 验证清单

### 8.1 三端在线

| 检查 | 方法 |
|---|---|
| 服务器健康 | `curl https://dshorb.top/health` → `{"status":"ok","meshApi":1,"mode":"account"}` |
| Mac 连着服务器 | `lsof -nP -iTCP \| grep -c "<relay-host>:443"` → 通常 3~4（Host + Client，可能多条） |
| Windows 连着服务器 | `Get-NetTCPConnection -State Established \| Where RemoteAddress -eq "<relay-host>"` → 通常 3 条 |
| 手机在线 | 手机互联页顶部「已连接 N/N」 |

节点在线状态只存在服务端内存里，**不会落盘**在 `/data/state.json` 的 `nodes` 里（那里只有注册信息），所以不要用那个文件判断在线。

### 8.2 跨设备派任务（本轮修复的核心路径）

在电脑的 Orb 面板里说：

> 告诉我都有哪些互联设备，各自在线吗、有哪些工作区。

期望：Agent 调 `device_agent_devices`，列出手机与另一台电脑及其工作区。

再说：

> 用 device_agent 让 <手机名> 在它的工作区创建 phone-test.txt，内容写 hello，然后回传给我。

期望：

1. Agent 先查设备（或直接用已知设备名）；
2. 返回 `Sent to <设备> (session ...)`；
3. 手机创建 `phone-background` 会话；
4. 文件回到电脑 `.mesh-in/<taskId>/`。

**失败时的正确表现**（这是 0.1.6 新增的能力）：返回具体原因，例如
`Not sent: needs_workspace. Detail: .... Available workspaces on <设备>: ...`。
如果只看到「没发出去」而没有原因，说明设备上跑的还是旧插件。

### 8.3 手机侧

按 `dsh-orb-android/docs/phone-device-testing.md` 的速查清单逐项过。

---

## 9. 排错速查

| 现象 | 最可能的原因 |
|---|---|
| 电脑端新功能不生效 | 漏了 `sync-mesh.mjs`，包里还是旧 `vendor/mesh` |
| 手机端新功能不生效 | runtime 没重打，或 APK 没重打（用的旧 `runtime/out`） |
| 插件有工具但 Agent 不用 | `cordis.patch.yml` 的提示词没跟着改（电脑端 / 手机 bridge 各有一份） |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名不一致：debug key 装的 vs release key 打的 |
| `ModuleNotFoundError: apk_delta` | 用了 `python3 -I tooling/...`，要把 cwd 切到 `tooling/` 再 `python3 release_assets.py` |
| `guide: README.md: want one line ...` | 升了 pubspec 版本但没同步 `docs/guide/README.md` |
| Windows 点不动 / 看不到窗口 | SSH 在 session 0；GUI 必须投递到 session 1 |
| Windows 计划任务 `0x80070534` | 用了 `WORKGROUP\<user>` 而不是 SID |
| 某台设备显示在线但派不过去 | 该设备的 Host 控制连接掉了；看它的 mesh 日志，别急着判设备崩溃 |

---

## 10. 提交前的安全检查

三个仓库都要过一遍，尤其是 `dsh-orb-cordis` 是**公开仓库**：

```sh
git grep -n -I -E \
  '<你的服务器IP>|BEGIN (RSA|OPENSSH|EC|PRIVATE) PRIVATE KEY|ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|/Users/<你的用户名>|storePassword' \
  -- . ':!runtime/out' ':!dist'
```

文档里的本机路径写 `~/` 或 `<user>`，主机名写 `<windows-host>`，配对码写占位符。

只推目标分支，**不要 `git push --all` / `--mirror`**——本地有 `backup/pre-scrub-*` 这类含旧敏感历史的 ref，推上去等于重新公开。
