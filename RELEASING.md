# 发布流程（维护者用）

面向维护者。目标：任何一次发布都是**可复现、可回滚、用户能查到**的。

## 版本号怎么走

遵循[语义化版本](https://semver.org/lang/zh-CN/)，`package.json` 的 `version` 与 git tag 保持一致：

| 改动性质 | 版本 | 例子 |
|---|---|---|
| 破坏性变更（用户需改配置/行为变了） | 次版本（0.x.0） | 0.1.0 → 0.2.0 |
| 新增能力，向后兼容 | 次版本（0.x.0） | 0.1.0 → 0.2.0 |
| 修 bug / 文案 / 文档 | 修订号（0.1.x） | 0.1.0 → 0.1.1 |

> 0.x 期间**次版本号承担破坏性变更**，请在 CHANGELOG 中显式标注。

## 一次发布的完整动作

1. **确认主线健康**：`node --check lib/*.js` 全部通过；`test/*.test.mjs` 全绿
   （CI 亦会跑；若 CI 因 token 缺 `workflow` 权限未启用，需本地跑）
2. **改版本号**：`package.json` 的 `version`
3. **写 CHANGELOG**：把 `[Unreleased]` 的内容整理成新版本小节，并更新底部比较链接
4. **提交**：`git commit -m "release: vX.Y.Z"`
5. **打 tag**：`git tag -a vX.Y.Z -m "vX.Y.Z"`
6. **推**：`git push origin main && git push origin vX.Y.Z`
7. **建 GitHub Release**：标题 `vX.Y.Z`，正文用 CHANGELOG 该小节内容
8. **附 tarball**（给 GitHub 慢/连不上的用户）：
   ```sh
   pnpm pack                     # 生成 dsh-control-X.Y.Z.tgz
   # 上传到该 Release 的资产里
   ```
9. **（可选）发 npm**：`research2/publish.sh`（需要 NPM_TOKEN）

## 用户侧：安装与更新语义（务必写进 CHANGELOG）

- **默认装到哪一版**：`github:6mt/dsh-control` 解析为**默认分支最新提交**，
  并在用户的 profile lockfile 里**锁定到该 commit**——之后不会自动跟进
- **怎么更新**：见 README「版本与更新」一节
- **怎么固定版本**：`github:6mt/dsh-control#v0.1.0`

**推论（重要）**：因为新用户总是装到 main 的最新提交，**main 必须随时可发布**——
不在 main 上留半成品，破坏性改动要么进次版本 tag、要么等下一个版本。

## 与 dsh 版本的关系

- `package.json` 的 `peerDependencies` 声明所依赖的 dsh 包范围（当前 `^0.2.0-rc.2`）
- README 与市场卡片都写明"需 dsh ≥ 0.2.0-rc.2"
- dsh 升到不兼容版本时：改 peer 范围 → 次版本号递增 → CHANGELOG 里点明"需 dsh ≥ x"
