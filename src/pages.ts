/**
 * Turns the paths of a built site's files into the paths visitors can open. Every `.html` file gives its own path
 * (`/about.html`) and its clean one (`/about`); `index.html` gives its folder (`/blog`, or `/` for the root) and
 * its own path. Pass them as `livePaths` to find redirects that shadow pages.
 *
 * @example
 * livePathsFromFiles(['index.html', 'blog/index.html', 'about.html', 'logo.png'])
 * // ['/', '/about', '/about.html', '/blog', '/blog/index.html', '/index.html']
 */
export function livePathsFromFiles(files: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const rel = file.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel.toLowerCase().endsWith('.html')) continue;
    paths.add(`/${rel}`);
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    if (name.toLowerCase() === 'index.html') paths.add(`/${parts.slice(0, -1).join('/')}`);
    else paths.add(`/${rel.slice(0, -'.html'.length)}`);
  }
  return [...paths].sort();
}
