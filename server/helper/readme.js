import fs from 'fs'
import path from 'path'

/** 可识别的 README 文件名 */
const README_FILE_REG = /^readme(\.(md|markdown|mdown|txt))?$/i
/** 单次请求的默认超时时间（毫秒） */
const DEFAULT_REQUEST_TIMEOUT = 4000
/** 直连 raw.githubusercontent.com 的超时时间，国内通常无法访问，避免等待太久 */
const GITHUB_RAW_TIMEOUT = 2500
/** 所有远程请求的总超时时间（毫秒） */
const DEFAULT_TOTAL_TIMEOUT = 12000
/** README 最大读取体积（1MB） */
const MAX_README_SIZE = 1024 * 1024

/** 支持的插件仓库平台 */
const PLATFORMS = [
  {platform: 'github', hostReg: /(^|\.)github\.com$/i},
  {platform: 'gitee', hostReg: /(^|\.)gitee\.com$/i},
  {platform: 'gitlab', hostReg: /(^|\.)gitlab\.com$/i},
  {platform: 'gitcode', hostReg: /(^|\.)gitcode\.(com|net)$/i},
]

/**
 * 解析插件仓库链接
 * 支持 GitHub、Gitee、GitLab、GitCode 的仓库地址（含 .git 后缀、tree 分支地址）
 * @param {string} link 插件链接
 * @return {{platform: string, owner: string, repo: string, branch: string|null}|null}
 */
export function parsePluginRepo(link) {
  if (typeof link !== 'string' || !link.trim()) {
    return null
  }
  let url
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  const hostname = url.hostname.toLowerCase()
  const platform = PLATFORMS.find(({hostReg}) => hostReg.test(hostname))?.platform
  if (!platform) {
    return null
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    return null
  }
  const owner = decodeSegment(segments[0])
  const repo = decodeSegment(segments[1]).replace(/\.git$/i, '')
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
    return null
  }
  let branch = null
  const treeIndex = segments.indexOf('tree')
  if (treeIndex > 1) {
    const branchName = decodeSegment(segments[treeIndex + 1] || '')
    branch = isSafeSegment(branchName) ? branchName : null
  }
  return {platform, owner, repo, branch}
}

/**
 * 读取本地已安装插件的 README
 * 插件已安装时优先使用本地文件，无需网络，也不会受 GitHub 访问异常影响
 * @param {string} pluginsPath 插件目录（Yunzai 根目录下的 plugins）
 * @param {string} repoName 仓库名称（即插件目录名，忽略大小写匹配）
 * @return {{text: string, filePath: string}|null}
 */
export function findLocalReadme(pluginsPath, repoName) {
  if (!pluginsPath || !repoName) {
    return null
  }
  let dirNames
  try {
    dirNames = fs.readdirSync(pluginsPath)
  } catch {
    return null
  }
  const targetName = repoName.toLowerCase()
  const dirName = dirNames.find(name => name.toLowerCase() === targetName)
  if (!dirName) {
    return null
  }
  const dirPath = path.join(pluginsPath, dirName)
  let fileNames
  try {
    fileNames = fs.readdirSync(dirPath)
  } catch {
    return null
  }
  // 优先使用 README.md，其余 README 文件作为备选
  fileNames.sort((a, b) => {
    const aDefault = /^readme\.md$/i.test(a) ? 0 : 1
    const bDefault = /^readme\.md$/i.test(b) ? 0 : 1
    return aDefault - bDefault
  })
  for (const fileName of fileNames) {
    if (!README_FILE_REG.test(fileName)) {
      continue
    }
    const filePath = path.join(dirPath, fileName)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile() || stat.size > MAX_README_SIZE) {
        continue
      }
      const text = stripBom(fs.readFileSync(filePath, 'utf8'))
      if (text.trim()) {
        return {text, filePath}
      }
    } catch {
      // 忽略无法读取的文件，继续尝试下一个
    }
  }
  return null
}

/**
 * 构建远程 README 的候选地址（按推荐顺序排列）
 * GitHub 会依次尝试反代、raw、Gitee 镜像与 jsDelivr CDN
 * @param {{platform: string, owner: string, repo: string, branch: string|null}} repo
 * @param {string} [proxyUrl] GitHub 反代地址
 * @return {{url: string, timeout: number}[]}
 */
export function buildReadmeCandidates(repo, proxyUrl) {
  if (!repo) {
    return []
  }
  const {platform, owner, branch} = repo
  const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo.repo)}`
  const refs = branch ? [branch, 'master', 'main'] : ['master', 'main']
  const candidates = []
  const added = new Set()
  const push = (url, timeout = DEFAULT_REQUEST_TIMEOUT) => {
    if (!url || added.has(url)) {
      return
    }
    added.add(url)
    candidates.push({url, timeout})
  }
  const githubRaw = ref => `https://raw.githubusercontent.com/${repoPath}/${encodeURIComponent(ref)}/README.md`

  if (platform === 'github') {
    if (proxyUrl) {
      const proxyBase = /\/$/.test(proxyUrl) ? proxyUrl : `${proxyUrl}/`
      push(`${proxyBase}${githubRaw('HEAD')}`, 5000)
    }
    // HEAD 会自动跟随仓库默认分支
    push(githubRaw('HEAD'), GITHUB_RAW_TIMEOUT)
    // Gitee 镜像，国内一般可访问，且 404 返回很快
    push(`https://gitee.com/${repoPath}/raw/master/README.md`)
    push(`https://gitee.com/${repoPath}/raw/main/README.md`)
    // jsDelivr CDN，@latest 会自动跟随默认分支
    const cdnRef = branch ? encodeURIComponent(branch) : 'latest'
    push(`https://cdn.jsdelivr.net/gh/${repoPath}@${cdnRef}/README.md`)
    push(`https://fastly.jsdelivr.net/gh/${repoPath}@${cdnRef}/README.md`)
    if (branch) {
      push(githubRaw(branch), GITHUB_RAW_TIMEOUT)
    }
  } else if (platform === 'gitee') {
    for (const ref of refs) {
      push(`https://gitee.com/${repoPath}/raw/${encodeURIComponent(ref)}/README.md`)
    }
  } else if (platform === 'gitlab') {
    for (const ref of refs) {
      push(`https://gitlab.com/${repoPath}/-/raw/${encodeURIComponent(ref)}/README.md`)
    }
  } else if (platform === 'gitcode') {
    for (const ref of refs) {
      push(`https://gitcode.com/${repoPath}/raw/${encodeURIComponent(ref)}/README.md`)
    }
  }
  return candidates
}

/**
 * 构建 README 中相对链接的基准地址
 * GitHub 优先使用反代，未配置时使用 jsDelivr，避免 raw.githubusercontent.com 无法访问导致图片失效
 * @param {{platform: string, owner: string, repo: string, branch: string|null}} repo
 * @param {string} [proxyUrl] GitHub 反代地址
 * @return {string}
 */
export function buildReadmeBaseUrl(repo, proxyUrl) {
  if (!repo) {
    return ''
  }
  const {platform, owner, branch} = repo
  const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo.repo)}`
  const ref = branch ? encodeURIComponent(branch) : ''
  switch (platform) {
    case 'github':
      if (proxyUrl) {
        const proxyBase = /\/$/.test(proxyUrl) ? proxyUrl : `${proxyUrl}/`
        return `${proxyBase}https://raw.githubusercontent.com/${repoPath}/${ref || 'HEAD'}`
      }
      return `https://cdn.jsdelivr.net/gh/${repoPath}@${ref || 'latest'}`
    case 'gitee':
      return `https://gitee.com/${repoPath}/raw/${ref || 'master'}`
    case 'gitlab':
      return `https://gitlab.com/${repoPath}/-/raw/${ref || 'master'}`
    case 'gitcode':
      return `https://gitcode.com/${repoPath}/raw/${ref || 'master'}`
    default:
      return ''
  }
}

/**
 * 从候选地址中获取 README 内容
 * 单个地址失败或超时后会继续尝试下一个，整体耗时受 totalTimeout 限制
 * @param {{url: string, timeout: number}[]} candidates 候选地址
 * @param {Function} fetchImpl fetch 实现
 * @param {{totalTimeout?: number}} [options]
 * @return {Promise<{text: string|null, baseUrl: string|null, url: string|null, failures: {url: string, reason: string}[]}>}
 */
export async function fetchReadmeFromRemote(candidates, fetchImpl, options = {}) {
  const {totalTimeout = DEFAULT_TOTAL_TIMEOUT} = options
  const failures = []
  if (typeof fetchImpl !== 'function' || !Array.isArray(candidates) || candidates.length === 0) {
    return {text: null, baseUrl: null, url: null, failures}
  }
  const startTime = Date.now()
  for (const candidate of candidates) {
    const remaining = totalTimeout - (Date.now() - startTime)
    if (remaining <= 0) {
      failures.push({url: candidate.url, reason: '已达到总超时时间'})
      break
    }
    const timeout = Math.min(candidate.timeout || DEFAULT_REQUEST_TIMEOUT, remaining)
    try {
      const text = await requestText(fetchImpl, candidate.url, timeout)
      if (!text.trim()) {
        failures.push({url: candidate.url, reason: '内容为空'})
        continue
      }
      return {
        text,
        baseUrl: candidate.url.replace(/\/README\.md$/i, ''),
        url: candidate.url,
        failures,
      }
    } catch (e) {
      failures.push({url: candidate.url, reason: formatFailureReason(e)})
    }
  }
  return {text: null, baseUrl: null, url: null, failures}
}

/**
 * 请求文本内容，带超时与内容校验
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {number} timeout
 * @return {Promise<string>}
 */
async function requestText(fetchImpl, url, timeout) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const abortTimer = controller ? setTimeout(() => controller.abort(), timeout) : null
  const request = (async () => {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': 'Guoba-Plugin',
        'Accept': 'text/plain, text/markdown, */*',
      },
      redirect: 'follow',
      signal: controller?.signal,
      // node-fetch v2 支持 timeout 参数，其他实现会忽略
      timeout,
    })
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`)
    }
    const contentLength = Number(response.headers?.get?.('content-length') || 0)
    if (contentLength > MAX_README_SIZE * 2) {
      throw new Error('README 体积过大')
    }
    const text = stripBom(await response.text())
    const contentType = (response.headers?.get?.('content-type') || '').toLowerCase()
    // 部分镜像失败时会返回 HTML 页面，需要排除
    if (contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(text.slice(0, 256))) {
      throw new Error('返回内容不是 README')
    }
    return text.slice(0, MAX_README_SIZE)
  })()
  let raceTimer = null
  let completed = false
  const timeoutPromise = new Promise((_, reject) => {
    raceTimer = setTimeout(() => reject(createTimeoutError()), timeout + 200)
  })
  try {
    const text = await Promise.race([request, timeoutPromise])
    completed = true
    return text
  } finally {
    if (abortTimer) {
      clearTimeout(abortTimer)
    }
    if (raceTimer) {
      clearTimeout(raceTimer)
    }
    // 超时后主动断开连接，避免请求一直挂着
    if (!completed) {
      controller?.abort()
    }
  }
}

function createTimeoutError() {
  const error = new Error('请求超时')
  error.name = 'TimeoutError'
  return error
}

function formatFailureReason(error) {
  if (!error) {
    return '未知错误'
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return '请求超时'
  }
  return error.message || String(error)
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return ''
  }
}

function isSafeSegment(segment) {
  return typeof segment === 'string'
    && /^[A-Za-z0-9._-]+$/.test(segment)
    && segment !== '.'
    && segment !== '..'
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}
