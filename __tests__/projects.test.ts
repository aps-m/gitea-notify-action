import * as core from '@actions/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { moveIssueToColumn } from '../src/projects'

const repo = 'https://git.example.com:3443/tools/gitea/api/v1/repos/team/app'
const endpoint = `${repo}/issues/1/comments`
const project = { id: 7, title: 'Release', type: 'repository', state: 'open' }
const column = { id: 9, title: 'Тестирование' }

describe('project moves', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>
  beforeEach(() => {
    jest.spyOn(core, 'warning').mockImplementation()
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async url => {
        const path = String(url)
        if (path === `${repo}/issues/1`)
          return Response.json({ id: 101, projects: [project] })
        if (path === `${repo}/projects/7/columns?limit=50&page=1`)
          return Response.json([column])
        if (path === `${repo}/projects/7/columns?limit=50&page=2`)
          return Response.json([])
        if (path === `${repo}/projects/7/issues/101/move`)
          return new Response(null, { status: 204 })
        throw new Error('Unexpected request')
      })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('defaults action metadata to the Russian column title', () => {
    const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8')
    expect(action).toMatch(/move_to_column:[\s\S]*?default: 'Тестирование'/)
  })

  it('uses global issue ID, token auth, a subpath, and accepts an empty 204 response', async () => {
    await moveIssueToColumn(endpoint, 'secret', column.title, '')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${repo}/projects/7/issues/101/move`,
      {
        method: 'POST',
        headers: {
          Authorization: 'token secret',
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({ column_id: 9 }),
        redirect: 'manual',
        signal: expect.any(AbortSignal)
      }
    )
  })

  it('reads later column pages even when the server caps page size', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 101, projects: [project] }))
      .mockResolvedValueOnce(Response.json([{ id: 8, title: 'Work' }]))
      .mockResolvedValueOnce(Response.json([column]))
      .mockResolvedValueOnce(Response.json([]))
    await moveIssueToColumn(endpoint, 'secret', column.title, '')
    expect(fetchMock).toHaveBeenCalledWith(
      `${repo}/projects/7/columns?limit=50&page=3`,
      expect.anything()
    )
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it.each([
    { projects: [], title: '', count: 0 },
    { projects: null, title: '', count: 0 },
    { projects: [project, { ...project, id: 8 }], title: '', count: 2 },
    { projects: [project], title: 'Missing', count: 0 },
    { projects: [{ ...project, state: 'closed' }], title: '', count: 0 },
    { projects: [{ ...project, type: 'organization' }], title: '', count: 0 }
  ])(
    'rejects unavailable or ambiguous projects: %j',
    async ({ projects, title, count }) => {
      fetchMock.mockResolvedValueOnce(Response.json({ id: 101, projects }))
      await expect(
        moveIssueToColumn(endpoint, 'secret', column.title, title)
      ).rejects.toThrow(`found ${count}`)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([{ columns: [] }, { columns: [column, { ...column, id: 10 }] }])(
    'rejects missing or ambiguous columns: %j',
    async ({ columns }) => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ id: 101, projects: [project] }))
        .mockResolvedValueOnce(Response.json(columns))
        .mockResolvedValueOnce(Response.json([]))
      await expect(
        moveIssueToColumn(endpoint, 'secret', column.title, '')
      ).rejects.toThrow('expected one column')
      expect(
        fetchMock.mock.calls.every(call => call[1]?.method === 'GET')
      ).toBe(true)
    }
  )

  it('stops repeated pages before writing anything', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 101, projects: [project] }))
      .mockImplementation(async () => Response.json([column]))
    await expect(
      moveIssueToColumn(endpoint, 'secret', column.title, '')
    ).rejects.toThrow('repeated a column page')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([
    null,
    {},
    { id: 0, projects: [project] },
    { id: 101 },
    { id: 101, projects: [{}] }
  ])('rejects invalid issue data %j', async issue => {
    fetchMock.mockResolvedValueOnce(Response.json(issue))
    await expect(
      moveIssueToColumn(endpoint, 'secret', column.title, '')
    ).rejects.toThrow('invalid issue/project data')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([{ columns: {} }, { columns: [{ id: 0, title: 'Testing' }] }])(
    'rejects invalid column data %j',
    async ({ columns }) => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ id: 101, projects: [project] }))
        .mockResolvedValueOnce(Response.json(columns))
      await expect(
        moveIssueToColumn(endpoint, 'secret', column.title, '')
      ).rejects.toThrow('invalid')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it.each([200, 302, 403, 404, 422])(
    'does not report success on move HTTP %s',
    async status => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ id: 101, projects: [project] }))
        .mockResolvedValueOnce(Response.json([column]))
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(
          new Response('sensitive server output', { status })
        )
      const result = moveIssueToColumn(endpoint, 'secret', column.title, '')
      await expect(result).rejects.toThrow(`HTTP ${status}`)
      await expect(result).rejects.not.toThrow('sensitive server output')
      expect(fetchMock).toHaveBeenCalledTimes(4)
    }
  )

  it('retries only the move request after a transient failure', async () => {
    jest.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: 101, projects: [project] }))
      .mockResolvedValueOnce(Response.json([column]))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const result = moveIssueToColumn(endpoint, 'secret', column.title, '')
    await jest.advanceTimersByTimeAsync(5000)
    await result
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls[3]).toEqual(fetchMock.mock.calls[4])
  })
})
