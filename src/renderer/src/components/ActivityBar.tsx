interface ActivityBarProps {
  active: string
  onChange: (id: string) => void
}

const FolderIcon = (): React.JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"/>
  </svg>
)

const ChipIcon = (): React.JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z"/>
  </svg>
)

const GitIcon = (): React.JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="2.5"/>
    <circle cx="6" cy="18" r="2.5"/>
    <circle cx="18" cy="9" r="2.5"/>
    <path d="M6 8.5v7"/>
    <path d="M18 11.5c0 3-4 2.5-6 4"/>
  </svg>
)

const PuzzleIcon = (): React.JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/>
    <path d="M10.5 3.75 8.25 6l2.25 2.25M13.5 3.75l2.25 2.25-2.25 2.25M10.5 14.25l-2.25 2.25 2.25 2.25M13.5 14.25l2.25 2.25-2.25 2.25"/>
  </svg>
)

const SettingsIcon = (): React.JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/>
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>
  </svg>
)

const BookIcon = (): React.JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 6.253v13.094C10.776 18.454 9.24 18 7.5 18c-1.74 0-3.276.454-4.5 1.347V5.347C4.224 4.454 5.76 4 7.5 4c1.74 0 3.276.454 4.5 2.253z"/>
    <path d="M12 6.253v13.094C13.224 18.454 14.76 18 16.5 18c1.74 0 3.276.454 4.5 1.347V5.347C20.776 4.454 19.24 4 17.5 4c-1.74 0-3.276.454-4.5 2.253z"/>
  </svg>
)

const ITEMS = [
  { id: 'files', icon: FolderIcon, label: '文件' },
  // 课程面板暂隐藏（2026-10-01，用户：聚焦ESP32先做好，其他先不做。讲义整理好后恢复此入口）
  // { id: 'curriculum', icon: BookIcon, label: '课程' },
  { id: 'git', icon: GitIcon, label: '源代码管理' },
  { id: 'device', icon: ChipIcon, label: '设备' },
  { id: 'plugins', icon: PuzzleIcon, label: '插件' },
]

function ActivityBar({ active, onChange }: ActivityBarProps): React.JSX.Element {
  return (
    <div className="activitybar">
      {ITEMS.map((item) => {
        const Icon = item.icon
        return (
          <div
            key={item.id}
            className={`activity-item ${active === item.id ? 'active' : ''}`}
            onClick={() => onChange(item.id)}
            title={item.label}
          >
            <Icon />
          </div>
        )
      })}
      <div className="activity-spacer" />
      <div className="activity-item" title="设置">
        <SettingsIcon />
      </div>
    </div>
  )
}

export default ActivityBar
