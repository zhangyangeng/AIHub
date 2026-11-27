export type SiteId =
  | 'deepseek'
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'doubao'
  | 'kimi'
  | 'qwen'
  | 'grok';

export interface Message {
  role: 'user' | 'assistant' | 'tag';
  html: string;
}

export interface Pane {
  host: string;
  messages: Message[];
}

export interface Site {
  id: SiteId;
  name: string;
  host: string;
  color: string;
  tag: string;
  icon: string;
}

export const sites: Site[] = [
  { id: 'deepseek', name: 'DeepSeek', host: 'chat.deepseek.com', color: '#4D6BFE', tag: 'DEEPSEEK', icon: '/assets/sites/deepseek.svg' },
  { id: 'chatgpt', name: 'ChatGPT', host: 'chatgpt.com', color: '#10A37F', tag: 'CHATGPT', icon: '/assets/sites/chatgpt.svg' },
  { id: 'claude', name: 'Claude', host: 'claude.ai', color: '#C96442', tag: 'CLAUDE', icon: '/assets/sites/claude.svg' },
  { id: 'gemini', name: 'Gemini', host: 'gemini.google.com', color: '#4285F4', tag: 'GEMINI', icon: '/assets/sites/gemini.svg' },
  { id: 'doubao', name: '豆包', host: 'doubao.com', color: '#1668FF', tag: '豆包', icon: '/assets/sites/doubao.svg' },
  { id: 'kimi', name: 'Kimi', host: 'kimi.moonshot.cn', color: '#16181B', tag: 'KIMI', icon: '/assets/sites/kimi.svg' },
  { id: 'qwen', name: '通义千问', host: 'tongyi.aliyun.com', color: '#615CED', tag: 'QWEN', icon: '/assets/sites/qwen.svg' },
  { id: 'grok', name: 'Grok', host: 'grok.com', color: '#111111', tag: 'GROK', icon: '/assets/sites/grok.svg' },
];

export const siteById = Object.fromEntries(sites.map((s) => [s.id, s])) as Record<SiteId, Site>;

/** 首屏标签栏里可点的站点 */
export const heroTabIds: SiteId[] = ['deepseek', 'chatgpt', 'claude', 'doubao', 'kimi'];

/** 首屏左栏：点标签切换时替换的对话 */
export const heroPanes: Record<string, Pane> = {
  deepseek: {
    host: 'chat.deepseek.com',
    messages: [
      { role: 'user', html: 'invoke 一直报 not found，是不是参数名对不上？' },
      { role: 'tag', html: 'DEEPSEEK' },
      { role: 'assistant', html: '大概率是命令名。它要和 <code>#[tauri::command]</code> 后面那个函数名完全一致，包括大小写。前端 <code>invoke(\'get_sites\')</code> 对应 <code>fn get_sites</code>，写成 <code>getSites</code> 就会找不到。' },
      { role: 'user', html: '可是 dev 能跑，build 之后才报错。' },
      { role: 'assistant', html: '那就是产物路径。dev 走 <code>devUrl</code>，打包后走 <code>frontendDist</code>，两边指向的不是同一份 JS。' },
    ],
  },
  chatgpt: {
    host: 'chatgpt.com',
    messages: [
      { role: 'user', html: '几千条日志想按分钟聚合，写正则是不是太慢了？' },
      { role: 'tag', html: 'CHATGPT' },
      { role: 'assistant', html: '先把时间戳切出来转成整数分钟，再丢进 map 里累加。正则留到最后只用来拆字段，聚合本身不需要它。' },
    ],
  },
  claude: {
    host: 'claude.ai',
    messages: [
      { role: 'user', html: '这段逻辑要不要单独抽成函数？' },
      { role: 'tag', html: 'CLAUDE' },
      { role: 'assistant', html: '只有一处调用就先别抽。抽出去多一层跳转，等第二处出现时形状才看得清，那时再抽不会返工。' },
    ],
  },
  doubao: {
    host: 'doubao.com',
    messages: [
      { role: 'user', html: '帮我把这段报错信息写得更像人话。' },
      { role: 'tag', html: '豆包' },
      { role: 'assistant', html: '现在写的是「Error: invalid input」。改成「这个文件打不开，可能被别的程序占用了」，下面再附原始错误。' },
    ],
  },
  kimi: {
    host: 'kimi.moonshot.cn',
    messages: [
      { role: 'user', html: '这份 PDF 里的表格能直接抽成 CSV 吗？' },
      { role: 'tag', html: 'KIMI' },
      { role: 'assistant', html: '能，但跨页的表要先合并表头。建议先抽成两段，检查列数对得上再拼，否则错位很难查。' },
    ],
  },
};

/** 首屏右栏固定 Claude */
export const heroFixedPane: Pane = {
  host: 'claude.ai',
  messages: [
    { role: 'user', html: '同一段 Rust，你觉得哪种写法更稳？' },
    { role: 'tag', html: 'CLAUDE' },
    { role: 'assistant', html: '第二种。第一种里 <code>unwrap()</code> 在锁被 poison 之后会直接 panic，而这个函数是从 UI 线程调的，panic 会把整个窗口带走。改成返回 <code>Result</code>，让前端拿到 Err 再提示，代价只是多两行。' },
    { role: 'user', html: '但这样前端每处都要处理错误。' },
    { role: 'assistant', html: '不用每处。<code>invoke</code> 返回的是 Promise，一个全局 catch 就够了——真正需要单独处理的只有「创建站点」和「导入配置」这两处。' },
  ],
};

/** 满宽四格：正在同屏的四个站点 */
export const fourUpIds: SiteId[] = ['deepseek', 'claude', 'doubao', 'kimi'];

/** 满宽四格：后台进休眠的标签，用来表达「同时只渲染 4 格」 */
export const fourBackdropIds: SiteId[] = ['chatgpt', 'gemini', 'qwen', 'grok'];

export const fourUpPanes: Record<string, Pane> = {
  deepseek: {
    host: 'chat.deepseek.com',
    messages: [
      { role: 'user', html: '这个报错是类型不对还是空值？' },
      { role: 'assistant', html: '是空值。<code>user</code> 在第一次渲染时还没到，<code>user.name</code> 直接炸了。解构前加一个 <code>?.</code>，或者把整块包进 <code>if (user)</code> 里。' },
      { role: 'user', html: '那加载中的状态怎么放？' },
      { role: 'assistant', html: '单独占一层骨架，别用同一个 <code>if</code>。三态分开写，后面加错误提示时才不用重排结构。' },
    ],
  },
  claude: {
    host: 'claude.ai',
    messages: [
      { role: 'user', html: '这两个标题哪个更清楚？' },
      { role: 'assistant', html: '第一个。第二个把「一键」放在最前面，读者会先去找那个「一键」是什么，反而卡一下。标题先给对象，再给动作。' },
      { role: 'user', html: '副标要跟着改吗？' },
      { role: 'assistant', html: '要，但只改第一句。副标现在在重复标题的意思，换成「装完多大」这种读者真正会问的。' },
    ],
  },
  doubao: {
    host: 'doubao.com',
    messages: [
      { role: 'user', html: '把这段话改得像给同事发消息。' },
      { role: 'assistant', html: '「这个接口我先不动了，等你那边字段定了我再接。现在改了下周还得再改一遍。」' },
      { role: 'user', html: '会不会太随意？' },
      { role: 'assistant', html: '给同事发正好。要是发给客户，把「我先不动了」换成「建议等字段确认后再动」，其余不用变。' },
    ],
  },
  kimi: {
    host: 'kimi.moonshot.cn',
    messages: [
      { role: 'user', html: '这份合同里违约责任在第几条？' },
      { role: 'assistant', html: '第七条第 2 款。逾期超过 30 日，按日万分之五计违约金，上限是合同总额的 20%。' },
      { role: 'user', html: '和附件里的口径一致吗？' },
      { role: 'assistant', html: '不一致。附件写的是万分之三，且没有上限。正文优先，但建议把附件一起改掉，免得后面扯。' },
    ],
  },
};
