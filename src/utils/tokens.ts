/* Vibe Board — Token formatting and equivalent-cost display utilities */

export function formatTokens(n: number): string {
  if (n === 0) return '0'
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00'
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

/**
 * Formats an amount in the currency reported by the built-in price table.
 * Unknown models never reach this function — the caller shows Unknown instead.
 */
export function formatUsageCost(amount: number, currency: string): string {
  if (currency.toUpperCase() === 'USD') return formatCost(amount)
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}
