import { giteaRequest } from './gitea'

interface Identified {
  id: number
}

function hasId(value: unknown): value is Identified {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    Number.isSafeInteger(value.id) &&
    value.id > 0
  )
}

interface Project extends Identified {
  title: string
  type: string
  state: string
}

function isProject(value: unknown): value is Project {
  return (
    hasId(value) &&
    'title' in value &&
    typeof value.title === 'string' &&
    'type' in value &&
    typeof value.type === 'string' &&
    'state' in value &&
    typeof value.state === 'string'
  )
}

interface Column extends Identified {
  title: string
}

async function listColumns(apiUrl: string, token: string): Promise<Column[]> {
  const columns: Column[] = []
  const seen = new Set<number>()
  for (let page = 1; page <= 100; page++) {
    const items = await giteaRequest(`${apiUrl}?limit=50&page=${page}`, token, {
      method: 'GET'
    })
    if (!Array.isArray(items))
      throw new Error('Gitea returned an invalid column list.')
    if (items.length === 0) return columns
    for (const item of items) {
      if (
        !hasId(item) ||
        !('title' in item) ||
        typeof item.title !== 'string'
      ) {
        throw new Error('Gitea returned an invalid project column.')
      }
      if (seen.has(item.id))
        throw new Error('Gitea repeated a column page; stopped pagination.')
      seen.add(item.id)
      columns.push({ id: item.id, title: item.title })
    }
  }
  throw new Error('Gitea column pagination exceeded 100 pages.')
}

/** Move within an existing repository project; never attach to another project. */
export async function moveIssueToColumn(
  commentsApiUrl: string,
  token: string,
  columnTitle: string,
  projectTitle: string
): Promise<void> {
  // The caller supplies the canonical endpoint produced by commentsUrl().
  const match = commentsApiUrl.match(/^(.*)\/issues\/([1-9]\d*)\/comments$/)
  if (!match) throw new Error('Invalid issue comments API URL.')
  const [, repoApi, index] = match
  const issue = await giteaRequest(`${repoApi}/issues/${index}`, token, {
    method: 'GET'
  })
  if (
    !hasId(issue) ||
    !('projects' in issue) ||
    (issue.projects !== null &&
      (!Array.isArray(issue.projects) || !issue.projects.every(isProject)))
  ) {
    throw new Error(
      'Gitea returned invalid issue/project data. Moving issues requires Gitea 28.0.0 or newer.'
    )
  }
  const projects = (issue.projects ?? []).filter(
    project =>
      project.type === 'repository' &&
      project.state === 'open' &&
      (!projectTitle || project.title === projectTitle)
  )
  if (projects.length !== 1) {
    throw new Error(
      `Issue #${index}: expected one matching open repository project, found ${projects.length}. Check project membership or set "project_name".`
    )
  }
  const projectApi = `${repoApi}/projects/${projects[0].id}`
  const columns = (await listColumns(`${projectApi}/columns`, token)).filter(
    column => column.title === columnTitle
  )
  if (columns.length !== 1) {
    throw new Error(
      `Issue #${index}: expected one column named "${columnTitle}", found ${columns.length}.`
    )
  }
  // Issue numbers in web URLs differ from the global IDs required by this API.
  await giteaRequest(`${projectApi}/issues/${issue.id}/move`, token, {
    method: 'POST',
    body: { column_id: columns[0].id },
    emptyResponse: true
  })
}
