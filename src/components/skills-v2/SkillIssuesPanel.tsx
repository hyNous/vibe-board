import { useMemo, useState } from 'react'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { skillApiV2 } from '../../services/skillApiV2'
import type { DiagnosisIssue } from '../../services/skillApiV2'

// Skill issues used to live on their own "诊断与修复" tab. They now surface as
// hints inside the Skill library, so the checks and their fixes stay next to
// the Skills they talk about.
type IssueGroupId = 'unmanaged' | 'sync' | 'confirm' | 'library'

const ISSUE_GROUPS: Array<{ id: IssueGroupId; title: string }> = [
  { id: 'sync', title: '同步与快照' },
  { id: 'confirm', title: '需要你决定' },
  { id: 'unmanaged', title: '未接管的 Skill' },
  { id: 'library', title: '中心库整理' },
]

export function SkillIssuesPanel() {
  const state = useSkillStoreV2()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const stats = useMemo(() => summarizeIssues(state.issues), [state.issues])
  const groups = useMemo(() => groupIssues(state.issues), [state.issues])
  const busyNow = busy || state.busyAction === 'diagnosis'

  const runDiagnosis = async () => {
    setNotice(null)
    await state.runDiagnosis()
  }

  const fix = async (issue: DiagnosisIssue) => {
    if (issue.fixKind === 'confirm') {
      const text = `${friendlyTitle(issue)}\n\n${friendlyDetail(issue)}\n\n确认执行？此操作可能会改写 Skill 内容。`
      if (!confirm(text)) return
    }
    setBusy(true)
    setNotice(null)
    try {
      await skillApiV2.executeFixIssue(issue.issueType, issue.entityId || '')
      await state.runDiagnosis()
      setNotice('已处理 1 项问题。')
    } catch (e) {
      state.setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const safeFix = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const n = await skillApiV2.executeSafeFixes()
      await state.runDiagnosis()
      const remaining = useSkillStoreV2.getState().issues.length
      setNotice(n === 0 ? '没有可自动处理的安全问题。' : `已处理 ${n} 项安全问题，还剩 ${remaining} 项需要查看。`)
    } catch (e) {
      state.setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`sm2__issues${state.issues.length > 0 ? ' sm2__issues--warn' : ''}`} aria-label="Skill 问题提示">
      <div className="sm2__issues-head">
        <div>
          <h3>{state.issues.length === 0 ? 'Skill 状态正常' : `Skill 状态需要整理 · ${state.issues.length} 项`}</h3>
          <p>
            {state.issues.length === 0
              ? '中心库与 Agent 目录当前一致。若刚手动安装过 Skill，可以重新检查。'
              : `其中 ${stats.auto} 项可以安全修复，安全检查只会清理失效记录、断开的链接或刷新快照，不会删除 Skill 内容。`}
          </p>
        </div>
        <div className="sm2__issues-actions">
          <button className="sm2__btn sm2__btn--ghost" onClick={() => void runDiagnosis()} disabled={busyNow}>
            重新检查
          </button>
          <button className="sm2__btn sm2__btn--primary" onClick={() => void safeFix()} disabled={busyNow || stats.auto === 0}>
            修复安全项
          </button>
        </div>
      </div>

      {notice && <div className="sm2__notice sm2__notice--ok">{notice}</div>}
      {state.error && <div className="sm2__error">{state.error}</div>}

      {state.issues.length > 0 && (
        <div className="sm2__issues-list">
          {ISSUE_GROUPS.map((group) => {
            const items = groups[group.id]
            if (items.length === 0) return null
            return (
              <div key={group.id} className="sm2__issues-group">
                <div className="sm2__issues-group-head">
                  <span>{group.title}</span>
                  <em>{items.length}</em>
                </div>
                {items.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} busy={busyNow} onFix={fix} />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function IssueRow({ issue, busy, onFix }: { issue: DiagnosisIssue; busy: boolean; onFix: (issue: DiagnosisIssue) => void }) {
  return (
    <article className={`sm2__issues-row sm2__issues-row--${issue.fixKind}`}>
      <div className="sm2__issues-row-body">
        <strong>{friendlyTitle(issue)}</strong>
        <span>{friendlyDetail(issue)}</span>
      </div>
      {issue.fixKind === 'info' ? (
        <span className="sm2__issues-hint">{infoActionHint(issue)}</span>
      ) : (
        <button
          className={`sm2__btn ${issue.fixKind === 'confirm' ? 'sm2__btn--danger' : 'sm2__btn--primary'}`}
          disabled={busy}
          onClick={() => onFix(issue)}
        >
          {friendlyActionLabel(issue)}
        </button>
      )}
    </article>
  )
}

function summarizeIssues(issues: DiagnosisIssue[]) {
  return {
    auto: issues.filter((issue) => issue.fixKind === 'auto').length,
    confirm: issues.filter((issue) => issue.fixKind === 'confirm').length,
    info: issues.filter((issue) => issue.fixKind === 'info').length,
  }
}

function groupIssues(issues: DiagnosisIssue[]): Record<IssueGroupId, DiagnosisIssue[]> {
  return issues.reduce<Record<IssueGroupId, DiagnosisIssue[]>>(
    (acc, issue) => {
      acc[groupForIssue(issue)].push(issue)
      return acc
    },
    { unmanaged: [], sync: [], confirm: [], library: [] },
  )
}

function groupForIssue(issue: DiagnosisIssue): IssueGroupId {
  if (issue.issueType === 'agent_unmanaged') return 'unmanaged'
  if (issue.fixKind === 'confirm') return 'confirm'
  if (['broken_link', 'target_missing', 'orphan_claim', 'snapshot_stale', 'agents_managed_duplicate'].includes(issue.issueType)) return 'sync'
  return 'library'
}

function friendlyTitle(issue: DiagnosisIssue): string {
  switch (issue.issueType) {
    case 'agent_unmanaged':
      return `发现未接管 Skill${agentNameFromTitle(issue.title) ? ` · ${agentNameFromTitle(issue.title)}` : ''}`
    case 'snapshot_stale':
      return 'JSON 快照需要刷新'
    case 'broken_link':
      return '发现断开的 Skill 链接'
    case 'target_missing':
      return '发现失效的安装记录'
    case 'agents_managed_duplicate':
      return '.agents 里有已管理的重复 Skill'
    case 'orphan_claim':
      return '发现失效的 Skill 包占用记录'
    case 'copy_diverged':
      return '中心库和 Agent 副本都发生了修改'
    case 'copy_outdated':
      return 'Agent 副本落后于中心库'
    case 'copy_modified':
      return 'Agent 副本有本地修改'
    case 'center_unmanaged':
      return '中心库里有未登记的 Skill'
    case 'pack_member_missing':
      return 'Skill 包引用了缺失的成员'
    default:
      return issue.title || '需要查看的问题'
  }
}

function friendlyDetail(issue: DiagnosisIssue): string {
  if (issue.issueType === 'agent_unmanaged') {
    const path = pathFromDetail(issue.detail)
    const reason = reasonFromDetail(issue.detail)
    return `${path ? `${path}。` : ''}${unmanagedReasonText(reason)}`
  }
  if (issue.issueType === 'snapshot_stale') {
    return '中心库已经变化，JSON 快照还停留在旧版本。刷新后，外部工具和人工排查会看到最新状态。'
  }
  if (issue.issueType === 'broken_link') {
    return `${quotedPath(issue.detail)} 指向的 Skill 已不存在，可以清理这条断开的链接。`
  }
  if (issue.issueType === 'target_missing') {
    return `${quotedPath(issue.detail)} 已不在磁盘上，可以移除这条过期记录。`
  }
  if (issue.issueType === 'agents_managed_duplicate') {
    return `${quotedPath(issue.detail)} 已由中心库管理。建议删除 .agents/skills 里的这份重复目标，避免多个 Agent 隐式加载旧副本。`
  }
  if (issue.issueType === 'orphan_claim') {
    return '某个 Skill 包还占用着已不存在的安装目标，可以安全移除这条占用记录。'
  }
  if (issue.issueType === 'copy_diverged') {
    return '中心库和 Agent 里的副本都改过，需要你决定以哪一份为准。'
  }
  if (issue.issueType === 'copy_outdated') {
    return `${quotedPath(issue.detail)} 可以从中心库更新，但会改写 Agent 目录里的副本。`
  }
  if (issue.issueType === 'copy_modified') {
    return `${quotedPath(issue.detail)} 和中心库快照不同，需要确认是否把这份本地修改推回中心库。`
  }
  if (issue.issueType === 'center_unmanaged') {
    return '这个目录看起来是 Skill，但还没有进入 Vibe Board 的中心库索引。'
  }
  if (issue.issueType === 'pack_member_missing') {
    return '某个 Skill 包引用了中心库里不存在的 Skill，安装这个包时可能缺少内容。'
  }
  return stripInternalReason(issue.detail)
}

function unmanagedReasonText(reason: string): string {
  switch (reason) {
    case 'same_name_as_center_skill':
      return '本地已有同名 Skill，Vibe Board 暂时不会接管，避免覆盖你的内容。'
    case 'not_in_center_library':
      return '这个 Skill 不在中心库里。你可以在 Agent 管理页把它导入中心库，之后再让它对 Agent 生效。'
    case 'path_conflict':
      return '这个路径和现有管理记录冲突，需要先确认保留哪一份。'
    default:
      return 'Vibe Board 还没有接管这个 Skill。需要统一管理时，可以去 Agent 管理页接管。'
  }
}

function friendlyActionLabel(issue: DiagnosisIssue): string {
  switch (issue.issueType) {
    case 'snapshot_stale':
      return '刷新快照'
    case 'broken_link':
      return '清理断开链接'
    case 'target_missing':
      return '移除失效记录'
    case 'agents_managed_duplicate':
      return '删除 .agents 重复项'
    case 'orphan_claim':
      return '移除占用记录'
    case 'copy_modified':
      return '推回中心库'
    case 'copy_outdated':
      return '更新副本'
    case 'copy_diverged':
      return '处理冲突'
    default:
      return issue.actions[0]?.label || '处理'
  }
}

function infoActionHint(issue: DiagnosisIssue): string {
  if (issue.issueType === 'agent_unmanaged') return '去 Agent 管理页接管'
  if (issue.issueType === 'center_unmanaged') return '导入中心库后即可管理'
  return '查看后按需处理'
}

function agentNameFromTitle(title: string): string {
  const prefix = 'Unmanaged skill in '
  return title.startsWith(prefix) ? title.slice(prefix.length).trim() : ''
}

function pathFromDetail(detail: string): string {
  const [path] = detail.split(' — reason:')
  return path?.trim() ?? ''
}

function reasonFromDetail(detail: string): string {
  const marker = 'reason:'
  const index = detail.indexOf(marker)
  return index >= 0 ? detail.slice(index + marker.length).trim() : ''
}

function quotedPath(detail: string): string {
  const match = detail.match(/'([^']+)'/)
  return match?.[1] ?? '目标路径'
}

function stripInternalReason(detail: string): string {
  return detail.replace(/\s+— reason:\s+[a-z0-9_/-]+/gi, '').trim()
}
