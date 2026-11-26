/**
 * 插件图标。游点灵的品牌色是 #5565fb（页面 theme-color），
 * 图形取「对话气泡 + 砖块」的抽象，和它的 AI 游戏创作定位对得上。
 */
export const icon = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#5565fb"/>' +
  '<rect x="12" y="34" width="12" height="8" rx="2" fill="#fff" opacity=".95"/>' +
  '<rect x="26" y="34" width="12" height="8" rx="2" fill="#fff" opacity=".72"/>' +
  '<rect x="40" y="34" width="12" height="8" rx="2" fill="#fff" opacity=".95"/>' +
  '<path d="M14 20h36a4 4 0 0 1 4 4v6H10v-6a4 4 0 0 1 4-4z" fill="#fff" opacity=".92"/>' +
  '<circle cx="24" cy="46" r="3" fill="#fff"/>' +
  '</svg>',
).toString('base64')
