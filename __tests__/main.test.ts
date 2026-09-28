import * as core from '@actions/core'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/main'

describe('action', () => {
  let directory: string
  let inputs: Record<string, string>
  let fetchMock: jest.SpiedFunction<typeof fetch>
  const firstUrl = 'https://git.example.com/team/app/issues/1#issuecomment-10'

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gitea-notify-'))
    inputs = {
      token: 'secret-token',
      to: 'https://git.example.com/team/app/issues/1'
    }
    // Exercise the toolkit's real required-input and whitespace handling.
    for (const name of [
      'token',
      'to',
      'changelog',
      'message',
      'message_file'
    ]) {
      delete process.env[`INPUT_${name.toUpperCase()}`]
    }
    jest.spyOn(core, 'setSecret').mockImplementation()
    jest.spyOn(core, 'setOutput').mockImplementation()
    jest.spyOn(core, 'setFailed').mockImplementation()
    jest.spyOn(core, 'info').mockImplementation()
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ id: 10, html_url: firstUrl }, { status: 201 })
      )
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    for (const name of [
      'token',
      'to',
      'changelog',
      'message',
      'message_file'
    ]) {
      delete process.env[`INPUT_${name.toUpperCase()}`]
    }
  })

  async function execute(): Promise<void> {
    for (const [name, value] of Object.entries(inputs)) {
      process.env[`INPUT_${name.toUpperCase()}`] = value
    }
    await run()
  }

  it('sends Markdown unchanged and exposes the created comment', async () => {
    inputs.message = ' \n  **Готово** 🚀\n\n    code\n '
    await execute()
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ body: inputs.message })
    )
    expect(core.setSecret).toHaveBeenCalledWith('secret-token')
    expect(core.setOutput).toHaveBeenCalledWith('comment_ids', '[10]')
    expect(core.setOutput).toHaveBeenCalledWith(
      'comment_urls',
      JSON.stringify([firstUrl])
    )
    expect(core.setOutput).toHaveBeenCalledWith('comment_count', 1)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('sends UTF-8 file contents before the inline message', async () => {
    inputs.message_file = join(directory, 'release.md')
    await writeFile(inputs.message_file, '# Изменения\n\n- Исправление 🔧\n')
    inputs.message = 'Deployment complete'
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: 9, html_url: 'https://git.example.com/#9' })
    )
    await execute()
    expect(
      fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).body)
    ).toEqual([await readFile(inputs.message_file, 'utf-8'), inputs.message])
    expect(core.setOutput).toHaveBeenCalledWith('comment_ids', '[9,10]')
    expect(core.setOutput).toHaveBeenCalledWith('comment_count', 2)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('supports a file without an inline message', async () => {
    inputs.message_file = join(directory, 'message.txt')
    await writeFile(inputs.message_file, 'Уведомление')
    await execute()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it.each(['', ' \n\t '])('rejects empty text %j', async message => {
    inputs.message = message
    await execute()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('non-empty text')
    )
  })

  it('rejects empty files and skips them when inline text is available', async () => {
    inputs.message_file = join(directory, 'empty.txt')
    await writeFile(inputs.message_file, ' \r\n\t ')
    await execute()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(core.setFailed).toHaveBeenCalledTimes(1)
    inputs.message = 'Actual notification'
    await execute()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(core.setFailed).toHaveBeenCalledTimes(1)
  })

  it.each(['token'])('requires %s', async name => {
    delete inputs[name]
    inputs.message = 'Text'
    await execute()
    expect(core.setFailed).toHaveBeenCalledWith(
      `Input required and not supplied: ${name}`
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a destination or changelog', async () => {
    delete inputs.to
    inputs.changelog = ' \n '
    inputs.message = 'Text'
    await execute()
    expect(core.setFailed).toHaveBeenCalledWith(
      'Provide an issue URL in "to" or text in "changelog".'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends file then inline message to every unique changelog issue without to', async () => {
    delete inputs.to
    inputs.changelog = `
- [First](https://git.example.com/team/app/issues/1)
- [Second](https://git.example.com/team/other/issues/2)
- https://git.example.com/team/app/issues/1#issuecomment-5
`
    inputs.message_file = join(directory, 'release.md')
    await writeFile(inputs.message_file, 'Файл 🚀\n')
    inputs.message = ' Выпущено!\n '
    let id = 0
    fetchMock.mockImplementation(async () => {
      id += 1
      return Response.json({ id, html_url: `https://git.example.com/#${id}` })
    })
    await execute()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://git.example.com/api/v1/repos/team/app/issues/1/comments',
      'https://git.example.com/api/v1/repos/team/app/issues/1/comments',
      'https://git.example.com/api/v1/repos/team/other/issues/2/comments',
      'https://git.example.com/api/v1/repos/team/other/issues/2/comments'
    ])
    expect(
      fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).body)
    ).toEqual(['Файл 🚀\n', inputs.message, 'Файл 🚀\n', inputs.message])
    expect(core.setOutput).toHaveBeenCalledWith('comment_ids', '[1,2,3,4]')
    expect(core.setOutput).toHaveBeenCalledWith('comment_count', 4)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('combines to and changelog without duplicating the explicit issue', async () => {
    inputs.changelog = `${inputs.to}/?view=all#comment-1\nhttps://git.example.com/team/app/issues/2`
    inputs.message = 'Text'
    await execute()
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://git.example.com/api/v1/repos/team/app/issues/1/comments',
      'https://git.example.com/api/v1/repos/team/app/issues/2/comments'
    ])
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('succeeds with zero outputs when changelog has no issue links', async () => {
    delete inputs.to
    inputs.changelog = '## Release\n- Documentation updates (#42)'
    inputs.message = 'Text'
    await execute()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(jest.mocked(core.setOutput).mock.calls).toEqual([
      ['comment_ids', '[]'],
      ['comment_urls', '[]'],
      ['comment_count', 0]
    ])
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('nothing to send')
    )
  })

  it('retains results and stops sending when a later issue fails', async () => {
    delete inputs.to
    inputs.changelog = [1, 2, 3]
      .map(id => `https://git.example.com/team/app/issues/${id}`)
      .join('\n')
    inputs.message = 'Text'
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 10, html_url: firstUrl }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
    await execute()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 403')
    )
    expect(jest.mocked(core.setOutput).mock.calls.slice(-3)).toEqual([
      ['comment_ids', '[10]'],
      ['comment_urls', JSON.stringify([firstUrl])],
      ['comment_count', 1]
    ])
  })

  it('validates the destination before sending', async () => {
    inputs.to = 'http://git.example.com/team/app/issues/1'
    inputs.message = 'Text'
    await execute()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('HTTPS')
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails before sending if the message file cannot be read', async () => {
    inputs.message_file = join(directory, 'missing.txt')
    inputs.message = 'Text'
    await execute()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('ENOENT')
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retains completed outputs when the second comment fails', async () => {
    inputs.message_file = join(directory, 'message.md')
    await writeFile(inputs.message_file, 'First')
    inputs.message = 'Second'
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 10, html_url: firstUrl }))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
    await execute()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 403')
    )
    expect(jest.mocked(core.setOutput).mock.calls.slice(-3)).toEqual([
      ['comment_ids', '[10]'],
      ['comment_urls', JSON.stringify([firstUrl])],
      ['comment_count', 1]
    ])
  })

  it('reports thrown values even when they are not Error objects', async () => {
    inputs.message = 'Text'
    fetchMock.mockRejectedValue('network unavailable')
    await execute()
    expect(core.setFailed).toHaveBeenCalledWith('network unavailable')
    expect(core.setOutput).toHaveBeenCalledWith('comment_count', 0)
  })
})
