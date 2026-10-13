import { expect, mock, test } from 'claude-code/testing'

const props = { title: 'File trail', isFocused: false, bodyColumns: 60, placement: 'dock' } as never

test('the pane draws its header and idle state on every surface', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'file-trail', surface, component: 'Pane', requestId: 'file-trail', props })
    expect(await ui.find({ type: 'Text', text: /touched/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /idle/ })).toBeDefined()
    await ui.unmount()
  }
})
