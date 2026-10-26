import * as core from '@actions/core'
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
  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(core, 'warning').mockImplementation()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

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

  it.each([301, 302, 307, 308, 400, 401, 403, 404, 422])(
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
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(response))
    await expect(createComment(endpoint, 'secret', 'text')).rejects.toThrow(
      'invalid comment response'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails on a non-JSON response', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<html>proxy</html>'))
    await expect(createComment(endpoint, 'secret', 'text')).rejects.toThrow(
      'Gitea returned an invalid JSON response.'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops after five network failures with four 5-second waits', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch failed'))
    const result = expect(
      createComment(endpoint, 'secret', 'text')
    ).rejects.toThrow('fetch failed (failed after 5 attempts).')
    for (let attempt = 1; attempt < 5; attempt++) {
      await jest.advanceTimersByTimeAsync(4_999)
      expect(fetchMock).toHaveBeenCalledTimes(attempt)
      await jest.advanceTimersByTimeAsync(1)
      expect(fetchMock).toHaveBeenCalledTimes(attempt + 1)
    }
    await result
    expect(core.warning).toHaveBeenCalledTimes(4)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('recovers from a network failure and stops after success', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json(comment))
    const timeoutMock = jest.spyOn(AbortSignal, 'timeout')
    const result = createComment(endpoint, 'secret', 'text')
    await jest.advanceTimersByTimeAsync(5_000)
    await expect(result).resolves.toEqual(comment)
    await jest.advanceTimersByTimeAsync(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      fetchMock.mock.calls[1][1]?.body
    )
    expect(timeoutMock).toHaveBeenCalledTimes(2)
    expect(timeoutMock.mock.results[0].value).not.toBe(
      timeoutMock.mock.results[1].value
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('attempt 2/5')
    )
  })

  it.each([408, 429, 500, 502, 503, 504])(
    'retries HTTP %s up to five times without disclosing the body',
    async status => {
      const cancelMocks: jest.SpyInstance[] = []
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => {
          const response = new Response('sensitive server output', { status })
          cancelMocks.push(jest.spyOn(response.body!, 'cancel'))
          return response
        })
      const result = createComment(endpoint, 'secret', 'text')
      const failed = expect(result).rejects.toThrow(`HTTP ${status}`)
      const privateBody = expect(result).rejects.not.toThrow(
        'sensitive server output'
      )
      await jest.advanceTimersByTimeAsync(20_000)
      await failed
      await privateBody
      expect(fetchMock).toHaveBeenCalledTimes(5)
      expect(core.warning).toHaveBeenCalledTimes(4)
      expect(
        JSON.stringify(jest.mocked(core.warning).mock.calls)
      ).not.toContain('sensitive server output')
      for (const cancel of cancelMocks) expect(cancel).toHaveBeenCalledTimes(1)
    }
  )

  it('stops immediately if a retry returns a permanent HTTP error', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
    const result = expect(
      createComment(endpoint, 'secret', 'text')
    ).rejects.toThrow('HTTP 403')
    await jest.advanceTimersByTimeAsync(5_000)
    await result
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('reports timeout while waiting for response headers', async () => {
    const controller = new AbortController()
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    const result = expect(
      createComment(endpoint, 'secret', 'text')
    ).rejects.toThrow('timed out after 30 seconds')
    await jest.advanceTimersByTimeAsync(20_000)
    await result
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('keeps the timeout active while reading the response body', async () => {
    const controller = new AbortController()
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = Response.json(comment)
      jest.spyOn(response, 'json').mockImplementation(async () => {
        controller.abort()
        throw new Error('aborted')
      })
      return response
    })
    const result = expect(
      createComment(endpoint, 'secret', 'text')
    ).rejects.toThrow('timed out')
    await jest.advanceTimersByTimeAsync(20_000)
    await result
    expect(fetch).toHaveBeenCalledTimes(5)
  })
})
