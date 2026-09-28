import { changelogDestinations } from '../src/changelog'

describe('changelog issue links', () => {
  it('extracts Markdown, autolinks, reference links and bare URLs in order', () => {
    expect(
      changelogDestinations(`
## Исправления
- [Задача](https://git.example.com/team/app/issues/1)
- <https://git.example.com/team/app/issues/2>
- https://git.example.com/team/app/issues/3.
- [Задача][issue]
[issue]: https://git.example.com/team/app/issues/4 "Описание"
`)
    ).toEqual(
      [1, 2, 3, 4].map(
        id =>
          `https://git.example.com/api/v1/repos/team/app/issues/${id}/comments`
      )
    )
  })

  it('deduplicates links with different fragments, queries and trailing slashes', () => {
    expect(
      changelogDestinations(`
https://git.example.com/team/app/issues/1
[Повтор](https://git.example.com/team/app/issues/1/?view=all#issuecomment-2)
<https://GIT.example.com:443/team/app/issues/1#issuecomment-3>
`)
    ).toEqual([
      'https://git.example.com/api/v1/repos/team/app/issues/1/comments'
    ])
  })

  it('preserves subpaths, ports and separate repositories', () => {
    expect(
      changelogDestinations(`
https://git.example.com:3443/gitea/team/app/issues/1;
https://git.example.com/team/other/issues/1,
`)
    ).toEqual([
      'https://git.example.com:3443/gitea/api/v1/repos/team/app/issues/1/comments',
      'https://git.example.com/api/v1/repos/team/other/issues/1/comments'
    ])
  })

  it.each([
    '',
    'No issues; #42 and team/app#43 are not full URLs.',
    'https://git.example.com/team/app/compare/v1...v2',
    'https://git.example.com/team/app/pulls/1',
    'https://git.example.com/team/app/issues/0',
    'https://git.example.com/team/app/issues/12abc',
    'https://git.example.com/team/app/issues/1/comments',
    'http://git.example.com/team/app/issues/1',
    'https://user:password@git.example.com/team/app/issues/1',
    'https://[invalid]/team/app/issues/1'
  ])('ignores unsupported links in %j', changelog => {
    expect(changelogDestinations(changelog)).toEqual([])
  })
})
