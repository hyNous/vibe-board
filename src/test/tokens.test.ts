import { describe, it, expect } from 'vitest'
import { formatTokens, formatCost, formatUsageCost } from '../utils/tokens'

describe('formatTokens', () => {
  it('returns "0" for zero', () => {
    expect(formatTokens(0)).toBe('0')
  })

  it('formats small numbers as-is', () => {
    expect(formatTokens(500)).toBe('500')
  })

  it('formats thousands with K suffix', () => {
    expect(formatTokens(1500)).toBe('1.5K')
  })

  it('formats millions with M suffix', () => {
    expect(formatTokens(2_500_000)).toBe('2.50M')
  })
})

describe('formatCost', () => {
  it('formats zero', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  it('shows <$0.01 for tiny costs', () => {
    expect(formatCost(0.005)).toBe('<$0.01')
  })

  it('formats normal costs', () => {
    expect(formatCost(1.234)).toBe('$1.23')
  })
})

describe('formatUsageCost', () => {
  // The built-in price table is the only source of amounts; this helper only
  // renders them and never applies a fallback price of its own.
  it('renders USD amounts like formatCost', () => {
    expect(formatUsageCost(2.5, 'USD')).toBe('$2.50')
  })

  it('renders other currencies without assuming a symbol', () => {
    expect(formatUsageCost(2.5, 'CNY')).toMatch(/2\.50/)
    expect(formatUsageCost(1, 'XYZ')).toMatch(/1\.00/)
  })
})
