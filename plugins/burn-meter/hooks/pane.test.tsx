import { expect, mock, test } from 'claude-code/testing'

const props = { title: 'Burn meter', isFocused: true, bodyColumns: 60, placement: 'dock' } as never

test('every section shows on one page', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'burn-meter', surface, component: 'Pane', requestId: 'burn-meter', props })
    for (const text of [/Burn meter/, /budget 10 sets a cap/, /Tokens/, /No turns yet/, /No readings yet/]) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    await ui.unmount()
  }
})
