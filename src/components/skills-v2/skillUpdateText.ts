import type { TFunction } from 'i18next'
import type { SkillUpdateCheckEntry, SkillUpdateErrorKind } from '../../services/skillApiV2'

export function skillUpdateErrorText(t: TFunction, kind: SkillUpdateErrorKind | null | undefined): string {
  if (kind === 'network') {
    return t('skills.updates.errors.network', {
      defaultValue: '网络不通，没能连上 GitHub。稍后再试。',
    })
  }
  if (kind === 'not_found') {
    return t('skills.updates.errors.notFound', {
      defaultValue: '找不到这个 Skill 的来源仓库，可能已被删除或改名。',
    })
  }
  if (kind === 'rate_limited') {
    return t('skills.updates.errors.rateLimited', {
      defaultValue: 'GitHub 暂时限制了访问频率，稍后再试。',
    })
  }
  return t('skills.updates.errors.unknown', {
    defaultValue: '没能完成这次检查，稍后再试。',
  })
}

export function changeSummaryText(
  t: TFunction,
  changes: NonNullable<SkillUpdateCheckEntry['changes']>,
): string {
  return t('skills.updates.changeSummary', {
    added: changes.added,
    modified: changes.modified,
    removed: changes.removed,
    defaultValue: '新增 {{added}} · 修改 {{modified}} · 删除 {{removed}}',
  })
}
