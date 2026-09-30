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
}
