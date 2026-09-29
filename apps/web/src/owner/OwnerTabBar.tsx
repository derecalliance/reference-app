/** The owner page's tabs, in the order they are shown. */
export type ActiveTab = 'participants' | 'replicas' | 'secrets' | 'shares' | 'recovery'

export interface OwnerTab {
  id: ActiveTab
  label: string
  /** Shown beside the label; every tab in this app counts something. */
  count: number
}

export interface OwnerTabBarProps {
  tabs: readonly OwnerTab[]
  active: ActiveTab
  onSelect: (tab: ActiveTab) => void
}

/**
 * The tab strip above the owner page's panels.
 *
 * Driven by a list rather than five hand-written buttons: they differed only in
 * label, count and id, so the repetition was the only place a wrong
 * `aria-selected` or a mismatched `activeTab` comparison could hide.
 */
export function OwnerTabBar({ tabs, active, onSelect }: OwnerTabBarProps) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          className={`tab-btn ${active === tab.id ? 'active' : ''}`}
          onClick={() => onSelect(tab.id)}
          aria-selected={active === tab.id}
        >
          {tab.label}
          <span className="tab-count">{tab.count}</span>
        </button>
      ))}
    </div>
  )
}
