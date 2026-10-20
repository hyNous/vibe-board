import { describe, expect, it } from 'vitest'
import {
  CUSTOM_NOTCH_HEIGHT_DEFAULT,
  getCollapsedIslandHeight,
  getIslandDragAnchor,
  MATCH_MENU_BAR_HEIGHT,
  MATCH_NOTCH_HEIGHT,
} from '../utils/islandLayout'

describe('island layout sizing', () => {

  it('resolves collapsed height modes consistently', () => {
    expect(getCollapsedIslandHeight('matchMenuBar', 52)).toBe(MATCH_MENU_BAR_HEIGHT)
    expect(getCollapsedIslandHeight('matchNotch', 52)).toBe(MATCH_NOTCH_HEIGHT)
    expect(getCollapsedIslandHeight('custom', 52)).toBe(52)
    expect(CUSTOM_NOTCH_HEIGHT_DEFAULT).toBe(MATCH_NOTCH_HEIGHT)
  })

  it('locates the side strip inside its oversized transparent host', () => {
    const anchor = getIslandDragAnchor({
      positionMode: 'right',
      hostWidth: 658,
      hostHeight: 612,
      shellWidth: 658,
      shellHeight: 320,
      hitboxHeight: 332,
      shellAnchorOffsetX: 0,
    })

    expect(anchor).toEqual({
      visibleWidth: 658,
      visibleHeight: 320,
      offsetX: 0,
      offsetY: 140,
    })
  })

  it('locates a left-docked strip and a centered top pill inside their hosts', () => {
    expect(getIslandDragAnchor({
      positionMode: 'left',
      hostWidth: 658,
      hostHeight: 612,
      shellWidth: 64,
      shellHeight: 132,
      hitboxHeight: 132,
      shellAnchorOffsetX: 0,
    })).toEqual({
      visibleWidth: 64,
      visibleHeight: 132,
      offsetX: 0,
      offsetY: 240,
    })

    expect(getIslandDragAnchor({
      positionMode: 'top',
      hostWidth: 754,
      hostHeight: 612,
      shellWidth: 140,
      shellHeight: 40,
      hitboxHeight: 40,
      shellAnchorOffsetX: 0,
    })).toEqual({
      visibleWidth: 140,
      visibleHeight: 40,
      offsetX: 307,
      offsetY: 0,
    })
  })
})
