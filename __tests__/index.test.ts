import * as main from '../src/main'

it('runs the action from its entrypoint', () => {
  const runMock = jest.spyOn(main, 'run').mockResolvedValue()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../src/index')
  expect(runMock).toHaveBeenCalledTimes(1)
})
