import { commentsUrl } from './gitea'

/** Extract full issue links from Markdown or plain text in first-seen order. */
export function changelogDestinations(changelog: string): string[] {
  const destinations = new Set<string>()
  const links = changelog.match(/https?:\/\/[^\s<>"'`[\]()]+/gi) ?? []
  for (const link of links) {
    // Sentence punctuation is not part of a bare issue link.
    const issueUrl = link.replace(/[.,;:!?]+$/, '')
    try {
      destinations.add(commentsUrl(issueUrl))
    } catch {
      // Changelogs can also contain commit, comparison and other non-issue links.
    }
  }
  return [...destinations]
}
