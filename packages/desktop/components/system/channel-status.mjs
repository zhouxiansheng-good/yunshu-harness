const issue = (label,reason,action)=>({state:'unavailable',label,reason,action});
const rules = [
  [/input must be provided either through stdin|\bEPIPE\b|ERR_STREAM_DESTROYED/iu,'工单正文未送达','执行器没有读到完整的工单正文。','请检查客户端版本与输入通道。'],
  [/claude-result-json-unavailable/iu,'Claude 回执无法读取','Claude Code 返回的内容无法解析为运行回执。','请核对客户端版本和输出格式。'],
  [/INVALID_TOOL_OUTPUT|returned invalid output|not lossless(?:ly)? JSON/iu,'工具回执格式不符','桌面宿主无法读取该工具的结果。','请检查云舒和宿主的版本。'],
  [/UNKNOWN_TOOL|unknown tool|TOOL_ACTIVATION_FAILED/iu,'会话未接入工具','当前会话没有接入所需工具。','请检查插件是否加载以及当前会话的工具权限。'],
  [/insufficient.quota|quota.exhaust|billing|credit balance|余额|足够额度|欠费|额度不足/iu,'额度不足','账户当前没有足够额度完成请求。','检查服务商余额或额度。'],
  [/\b429\b|rate.limit|too many requests|频率过高|限制了请求频率/iu,'请求过于频繁','渠道暂时限制了请求频率。','稍后重试，或调低并发。'],
  [/\b501\b|not implemented|unsupported.operation|没有实现请求的功能/iu,'接口不支持','当前服务没有实现请求的功能。','检查接入地址和所选功能。'],
  [/\b401\b|unauthori[sz]ed|not.logged.in|sign.in.required|credential.unavailable|invalid.api.key|authentication|有效的账户凭据/iu,'需要登录或密钥','渠道未取得有效的账户凭据。','登录对应客户端或更新渠道密钥。'],
  [/\b403\b|forbidden|access.denied|permission.denied|tool.*denied/iu,'权限不足','当前账户或工作区未授权这项操作。','检查渠道权限和工作区授权。'],
  [/cli.not.found|ENOENT.*spawn|executable.not.found/iu,'未找到客户端','本机没有找到对应的命令行程序。','安装客户端或修正可执行文件位置。'],
  [/model.not.found|model.unavailable|\b404\b/iu,'找不到模型或接口','配置的模型或请求地址无法使用。','核对模型名称与服务地址。'],
  [/relay.provider.not.configured|relay.config.unavailable|relay.settings.unavailable|official.provider/iu,'尚未配置','没有找到这个渠道的有效配置。','在本机客户端完成渠道配置。'],
  [/relay.endpoint.invalid|relay.responses.api.required|relay.requires.openai.auth/iu,'接入配置不匹配','当前地址或认证方式与渠道接口不匹配。','检查服务地址、接口类型和认证方式。'],
  [/ETIMEDOUT|time.?out|超时/iu,'响应超时','在等待时间内没有收到完整响应。','确认服务可访问后重试。'],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|network|DNS|fetch failed/iu,'连接失败','本机未能与渠道建立或维持连接。','检查网络、中转服务和代理设置。'],
  [/\b50[0234]\b|overloaded|service.unavailable/iu,'服务暂时异常','服务端当前无法完成请求。','稍后重试，或查看服务商状态。'],
  [/cancelled|aborted|取消|暂停/iu,'已中断','本次请求已经停止。','需要继续时由用户重新派单。'],
  [/sandbox|scope.violation|out.of.scope|outside.the.configured/iu,'工作区范围受限','执行器无法在当前授权范围内完成交付。','核对任务的工作区和允许修改的文件。'],
  [/task.text.budget.exceeded|audit.*limit|run.limit|预算/iu,'达到执行上限','本次工单超出已配置的容量或运行限制。','缩小本单范围，或调整对应配置。'],
  [/disabled|已关闭/iu,'已关闭','该功能当前处于关闭状态。','在云舒功能开关中启用。'],
];
export function channelIssue(error) {
  const message=String(error?.message??error??'');
  const match=rules.find(([pattern,,reason])=>pattern.test(message) || message.includes(reason));
  return match?issue(...match.slice(1)):issue('调用未成功','渠道没有交回可确认的结果。','检查该渠道的连接和最近一次运行记录。');
}
export function workflowReason(error) {
  const message=String(error?.message??error??'');
  const match=rules.find(([pattern,,reason])=>pattern.test(message) || message.includes(reason));
  if(match)return match[2]+match[3];
  return /^[\u3400-\u9fffA-Za-z\s]*[\u3400-\u9fff]/u.test(message) && !/https?:|bearer|token=|api.key=|\b[45]\d\d\b|[\r\n]/iu.test(message)
    ? message.slice(0,220) : '执行器没有交回可确认的结果，请核对最近一次运行记录。';
}

export function toolFailure(result,fallback) {
  const info=result?.error?.info;
  const message=result?.error?.message || result?.content?.find(block=>block.type==='text')?.text;
  if (info?.code && rules.some(([pattern])=>pattern.test(info.code))) return Error(workflowReason(info.code));
  return Error(message?.replace(/^Error:\s*/u,'') || fallback);
}
