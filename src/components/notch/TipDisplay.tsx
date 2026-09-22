import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../stores/configStore'
import { buildTips, shuffleTips } from './tips'

function useTipRotation(active: boolean, tips: string[]): string | null {
  const [tip, setTip] = useState<string | null>(() => tips[0] ?? null)
  const shuffledRef = useRef<string[]>([])
  const indexRef = useRef(0)

  const nextTip = useCallback(() => {
    if (shuffledRef.current.length === 0 || indexRef.current >= shuffledRef.current.length) {
      shuffledRef.current = shuffleTips(tips)
      indexRef.current = 0
    }
    const next = shuffledRef.current[indexRef.current] ?? tips[0]
    indexRef.current += 1
    return next
  }, [tips])

  useEffect(() => {
    shuffledRef.current = []
    indexRef.current = 0
    const id = window.setTimeout(() => setTip(tips[0] ?? null), 0)
    return () => window.clearTimeout(id)
  }, [tips])

  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => setTip(nextTip()), 0)
    return () => window.clearTimeout(id)
  }, [active, nextTip])

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => {
      setTip(nextTip())
    }, 10_000)
    return () => window.clearInterval(id)
  }, [active, nextTip])

  return tip
}

interface TipDisplayProps {
  show: boolean
}

export function TipDisplay({ show }: TipDisplayProps) {
  const { t } = useTranslation()
  const globalShortcut = useConfigStore((s) => s.globalShortcut)
  const tips = useMemo(() => buildTips(t, { globalShortcut }), [globalShortcut, t])
  const tip = useTipRotation(show, tips)
  if (!show || !tip) return null

  return (
    <div className="tip-display">
      <span className="tip-display__label">{t('notch.tipsLabel', { defaultValue: '小提示' })}</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={tip}
          className="tip-display__text"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {tip}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
