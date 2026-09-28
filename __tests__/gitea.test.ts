import { commentsUrl, createComment } from '../src/gitea'

describe('issue URL', () => {
  it.each([
    [
      'https://git.example.com/team/project/issues/42',
      'https://git.example.com/api/v1/repos/team/project/issues/42/comments'
    ],
    [
      'https://git.example.com:3443/tools/gitea/team/project/issues/42/?view=all#issuecomment-1',
      'https://git.example.com:3443/tools/gitea/api/v1/repos/team/project/issues/42/comments'
    ],
    [
      'https://git.example.com/team/my%20project/issues/1',
      'https://git.example.com/api/v1/repos/team/my%20project/issues/1/comments'
    ]
  ])('converts %s', (input, expected) => {
    expect(commentsUrl(input)).toBe(expected)
  })

  it.each([
    '',
    '/team/project/issues/1',
    'http://git.example.com/team/project/issues/1',
    'https://user:password@git.example.com/team/project/issues/1',
    'https://git.example.com/team/project/pulls/1',
    'https://git.example.com/team/project/issues/0',
    'https://git.example.com/team/project/issues/-1',
    'https://git.example.com/team/project/issues/abc',
    'https://git.example.com/team/project/issues/1/comments',
    'https://git.example.com/project/issues/1'
  ])('rejects invalid destination %s', input => {
    expect(() => commentsUrl(input)).toThrow()
  })
})

describe('Gitea API', () => {
  const endpoint =
    'https://git.example.com/api/v1/repos/team/app/issues/1/comments'
  const comment = {
    id: 123,
    html_url: 'https://git.example.com/team/app/issues/1#issuecomment-123'
  }

  it('posts UTF-8 Markdown with token auth, timeout and no redirects', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(comment, { status: 201 }))
    const timeoutMock = jest.spyOn(AbortSignal, 'timeout')
    const message = '  # Сборка готова 🚀\n\n**Версия:** 1.0\n'

    await expect(createComment(endpoint, 'secret', message)).resolves.toEqual(
      comment
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'token secret',
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ body: message }),
      redirect: 'manual',
      signal: expect.any(AbortSignal)
    })
    expect(timeoutMock).toHaveBeenCalledWith(30_000)
  })

  it.each([301, 302, 307, 308, 400, 401, 403, 404, 422, 429, 500])(
    'fails on HTTP %s without retry or response body disclosure',
    async status => {
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('sensitive server output', { status }))
      const result = createComment(endpoint, 'secret', 'notification')
      await expect(result).rejects.toThrow(`HTTP ${status}`)
      await expect(result).rejects.not.toThrow('sensitive server output')
      if (status < 400)
        await expect(result).rejects.toThrow('Redirects are disabled')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    null,
    {},
    { id: '1', html_url: 'url' },
    { id: -1, html_url: 'url' },
    { id: 1 },
    { id: 1, html_url: '' }
  ])('rejects malformed comment response %j', async response => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response))
    await expect(createComment(endpoint, 'secret', 'text')).rejects.toThrow(
      'invalid comment response'
    )
  })

  it('fails on a non-JSON response', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<html>proxy</html>'))
    await expect(createComment(endpoint, 'secret', 'text')).rejects.toThrow(
      'Gitea returned an invalid JSON response.'
    )
  })

  it('does not retry a network failure', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch failed'))
    await expect(createComment(endpoint, 'secret', 'text')).rejects.toThrow(
      'fetch failed'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports timeout while waiting for response headers', async () => {
    const controller = new AbortController()
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    await expect(createComment(endpoint, 'secret', 'text')).rejects.toThrow(
      'timed out after 30 seconds'
    )
  })

  it('keeps the timeout active while reading the response body', async () => {
    const controller = new AbortController()
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const response = Response.json(comment)
    jest.spyOn(response, 'json').mockImplementation(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(createComment(endpoint, 'secret', 'text')).rejects.toThrow(
      'timed out'
    )
  })
})
