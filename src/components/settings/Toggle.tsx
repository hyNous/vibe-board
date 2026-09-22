import { motion } from 'framer-motion'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}

export function Toggle({ checked, onChange, disabled, ariaLabel }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`toggle ${checked ? 'toggle--on' : 'toggle--off'}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <motion.div
        className="toggle__knob"
        animate={{ x: checked ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  )
}
