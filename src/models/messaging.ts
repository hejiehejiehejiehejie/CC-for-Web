export interface Message {
  action: MessageAction;
  payload?: any;
}

export enum MessageAction {
  Parse,
  SendTask,
  SendTaskDone,
  SendTaskFailed,
  Fetch,
  FetchResult,
  FetchFailed,
  // 下面两条来自自动解析脚本（src/autoParse.ts），方向是内容脚本 -> 后台。
  // 新值一律往后追加：这份枚举是跨进程的线上格式，插在中间会让旧标签页里的
  // 内容脚本把 Parse 认成别的动作。
  CheckSampleNeeded,
  RequestAutoParse,
  // 代填验证码（src/fillCode.ts）：方向是后台 -> 内容脚本。与上面两条同理，只能往后追加。
  FillCode,
  // 捎带回报 Codeforces 登录态（src/autoParse.ts）：方向是内容脚本 -> 后台。
  // 为什么不复用 FillCode：那一条是「后台叫内容脚本干活」，这一条方向相反，
  // 混用会让后台把自己的回报当成指令。同理，只能往后追加。
  ReportCfIdentity,
}
