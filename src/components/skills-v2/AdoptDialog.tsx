import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { skillApiV2 } from '../../services/skillApiV2'
import type { AdoptPreview } from '../../services/skillApiV2'
import { PreviewDialog } from './PreviewDialog'
import { SettingDetails } from '../settings/SettingDetails'
import { skillErrorMessage } from './skillLabels'

export function AdoptDialog({
  preview,
  onClose,
  onDone,
  validateContext,
}: {
  preview: AdoptPreview
  onClose: () => void
  onDone: () => void | Promise<void>
  validateContext?: () => void
}) {
  const { t } = useTranslation()
  const [option, setOption] = useState(() => preferredAdoptOption(preview.options))
  const [renamedId, setRenamedId] = useState('')
  const [adoptedSkillId, setAdoptedSkillId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedOption = preview.options.find((o) => o.value === option)
  const sharedOwner = preview.agentId === 'agents'
  const optionCopy = selectedOption ? adoptOptionCopy(selectedOption, sharedOwner) : null
  const effectiveRenamedId = renamedId.trim() || `${preview.inferredSkillId}-import`
  const changesFiles = Boolean(selectedOption?.destructive || (sharedOwner && option !== 'skip'))

  const execute = async () => {
    setBusy(true)
    setError(null)
    try {
      validateContext?.()
      const skillId = adoptedSkillId || await skillApiV2.executeAdopt(
        preview.agentId,
        preview.unmanagedId,
        option,
        option === 'rename' ? renamedId : null,
      )
      if (option !== 'skip' && !adoptedSkillId) setAdoptedSkillId(skillId)
      validateContext?.()
      await onDone()
    } catch (e) {
      setError(skillErrorMessage(t, e))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (adoptedSkillId) {
      setBusy(true)
      setError(null)
      void Promise.resolve(onDone())
        .catch((e) => {
          setError(skillErrorMessage(t, e))
          setBusy(false)
        })
      return
    }
    onClose()
  }

  return (
    <PreviewDialog
      title={`接管 ${preview.inferredSkillId || '未命名 Skill'}`}
      confirmLabel={adoptedSkillId ? '重试刷新' : option === 'skip' ? '保持未管理' : '确认接管'}
      modalClassName="sm2__modal--adopt"
      destructive={changesFiles}
      busy={busy}
      onConfirm={execute}
      onCancel={close}
    >
      <div className="sm2-adopt">
        <div className="sm2-adopt__summary">
          <div>
            <span>Skill</span>
            <strong>{preview.inferredSkillId || '未命名 Skill'}</strong>
          </div>
          <div>
            <span>Skill 库里有同名</span>
            <strong>{preview.centerHasSameId ? '有，需要你选一份' : '没有，可以直接收进来'}</strong>
          </div>
          <div className="sm2-adopt__summary-path">
            <SettingDetails testId="adopt-skill-path-details" label="详情">
              <div className="setting-details__row">
                <span>文件位置</span>
                <code>{preview.skillPath}</code>
              </div>
            </SettingDetails>
          </div>
        </div>

        <section className="sm2-adopt__section">
          <div className="sm2-adopt__section-head">
            <h4>选择接管方式</h4>
            <span>{preview.canQuickAdopt ? '可以直接导入中心库' : '中心库已有不同内容，需要处理冲突'}</span>
          </div>
          <div className="sm2-adopt__options" role="radiogroup" aria-label="接管方式">
            {preview.options.map((o) => {
              const copy = adoptOptionCopy(o, sharedOwner)
              const active = option === o.value
              return (
                <button
                  key={o.value}
                  type="button"
                  className={`sm2-adopt__option${active ? ' sm2-adopt__option--active' : ''}${o.destructive ? ' sm2-adopt__option--destructive' : ''}`}
                  role="radio"
                  aria-checked={active}
                  aria-label={copy.shortLabel}
                  disabled={Boolean(adoptedSkillId)}
                  onClick={() => {
                    setOption(o.value)
                    if (o.value === 'rename' && !renamedId.trim()) setRenamedId(`${preview.inferredSkillId}-import`)
                  }}
                >
                  <span className="sm2-adopt__radio" />
                  <span className="sm2-adopt__option-main">
                    <strong>{copy.title}</strong>
                    <span>{copy.description}</span>
                  </span>
                  <em>{copy.badge}</em>
                </button>
              )
            })}
          </div>
        </section>

        {option === 'rename' && (
          <div className="sm2-adopt__rename">
            <label htmlFor="sm2-adopt-rename">新的 Skill ID</label>
            <input
              id="sm2-adopt-rename"
              value={renamedId}
              onChange={(e) => setRenamedId(e.target.value)}
              placeholder={`${preview.inferredSkillId}-import`}
              disabled={Boolean(adoptedSkillId)}
            />
            <span>
              {sharedOwner
                ? `将以「${effectiveRenamedId}」写入中心库，成功后清理 .agents/skills 中的原共享 Skill。`
                : `将以「${effectiveRenamedId}」写入中心库，原 Agent 文件会作为副本目标被管理。`}
            </span>
          </div>
        )}

        {optionCopy && (
          <div className={`sm2-adopt__impact${changesFiles ? ' sm2-adopt__impact--warn' : ''}`}>
            <strong>
              {sharedOwner && option !== 'skip'
                ? '会清理 .agents 共享副本'
                : selectedOption?.destructive
                  ? '会改动 Agent 目录'
                  : '不会删除现有文件'}
            </strong>
            <span>{optionCopy.impact}</span>
          </div>
        )}

        {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
      </div>
    </PreviewDialog>
  )
}

function adoptOptionCopy(
  option: { value: string; label: string; destructive: boolean },
  sharedOwner = false,
) {
  switch (option.value) {
    case 'import_keep':
      return {
        title: '导入中心库，保留 Agent 文件',
        shortLabel: '保留 Agent 文件',
        description: '把这个 Skill 纳入中心库记录，Agent 目录里的原文件保持不动。',
        badge: '保留',
        impact: '适合先接管已有文件，后续再决定是否改成链接或副本。',
      }
    case 'import_link':
      return {
        title: '导入中心库，并替换为链接',
        shortLabel: '替换为软连接',
        description: '中心库成为唯一来源，Agent 目录改为指向中心库的链接。',
        badge: '推荐',
        impact: '会删除当前 Agent 目录中的 Skill 文件夹，再创建到中心库的链接。',
      }
    case 'import_copy':
      return {
        title: '导入中心库，并替换为副本',
        shortLabel: '替换为复制',
        description: '中心库保存一份，Agent 目录重新写入一份托管副本。',
        badge: '副本',
        impact: '会删除当前 Agent 目录中的 Skill 文件夹，再从中心库复制回 Agent。',
      }
    case 'import_cleanup':
      return {
        title: '导入中心库，并清理 .agents 原目录',
        shortLabel: '清理 .agents 原目录',
        description: '先复制到中心库，成功后删除 .agents/skills 中的原 Skill，避免共享目录隐式生效。',
        badge: '推荐',
        impact: '会删除 .agents/skills 里的原 Skill 文件夹；中心库会保留可管理副本。',
      }
    case 'center_over_agent':
      if (sharedOwner) {
        return {
          title: '使用中心库版本，并清理共享副本',
          shortLabel: '中心库为准',
          description: '保留中心库已有 Skill，成功后删除 .agents/skills 中的同名共享副本。',
          badge: '推荐',
          impact: '不会改动中心库；会删除 .agents/skills 中的同名共享 Skill 文件夹。',
        }
      }
      return {
        title: '使用中心库版本接管',
        shortLabel: '中心库为准',
        description: '保留中心库已有 Skill，把当前 Agent 目录替换为中心库链接。',
        badge: '推荐',
        impact: '不会改动中心库；会删除当前 Agent 目录中的同名 Skill 文件夹，再创建到中心库的链接。',
      }
    case 'overwrite_center':
      if (sharedOwner) {
        return {
          title: '用共享副本覆盖中心库',
          shortLabel: '共享副本为准',
          description: '以 .agents 共享目录中的版本覆盖中心库，成功后删除原共享副本。',
          badge: '覆盖',
          impact: '会替换中心库同名 Skill，并删除 .agents/skills 中的原共享 Skill 文件夹。',
        }
      }
      return {
        title: '用当前文件覆盖中心库',
        shortLabel: '覆盖中心库',
        description: '中心库已有同名 Skill，将以这个 Agent 里的版本为准。',
        badge: '覆盖',
        impact: '会替换中心库同名 Skill 的内容，请确认当前 Agent 文件是正确版本。',
      }
    case 'rename':
      if (sharedOwner) {
        return {
          title: '改名导入中心库，并清理共享副本',
          shortLabel: '重命名导入',
          description: '保留中心库已有同名 Skill，以新的 Skill ID 导入共享副本，成功后清理原共享目录。',
          badge: '改名',
          impact: '不会覆盖中心库已有 Skill；会删除 .agents/skills 中的原共享 Skill 文件夹。',
        }
      }
      return {
        title: '改名导入中心库',
        shortLabel: '重命名导入',
        description: '保留中心库已有同名 Skill，把当前文件作为新的 Skill ID 导入。',
        badge: '改名',
        impact: '不会覆盖中心库已有 Skill，也不会删除当前 Agent 文件。',
      }
    case 'skip':
      return {
        title: '暂不接管',
        shortLabel: '暂不接管',
        description: '保持这个 Skill 为未管理状态，本次不写入中心库。',
        badge: '跳过',
        impact: '不会改动中心库或 Agent 目录；下次扫描仍可能看到它。',
      }
    default:
      return {
        title: option.label,
        shortLabel: option.label,
        description: '使用 Vibe Board 后端建议的处理方式。',
        badge: option.destructive ? '会改动' : '安全',
        impact: option.destructive ? '执行前请确认该操作会修改现有文件。' : '该操作不会删除现有文件。',
      }
  }
}

function preferredAdoptOption(options: Array<{ value: string }>) {
  return options.find((option) => option.value === 'center_over_agent')?.value
    || options.find((option) => option.value === 'import_cleanup')?.value
    || options.find((option) => option.value === 'import_link')?.value
    || options[0]?.value
    || 'import_keep'
}
