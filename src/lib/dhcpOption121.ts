// DHCP Option 121（RFC 3442 无类静态路由）生成器。
//
// 本模块只读取当前规划结果与面板录入，绝不修改规划（plan）、基线、路由汇总、
// 主机登记、dnsmasq 静态租约与 JSON 导出。
//
// RFC 3442 编码（每条路由）：
//   1 字节目的前缀长度 P（0-32）；
//   ceil(P/8) 字节目的网络地址（仅前缀对应的高位字节，主机位省略，故目的必须为规范网络地址）；
//   4 字节下一跳路由器 IPv4（必须位于客户端网段的可用主机范围内）。
// 多条路由按「目的前缀从长到短、网络地址升序」排列后顺序拼接，
// 即 dnsmasq 的 `dhcp-option=121,<十进制字节...>`（字节间以逗号分隔）。

import { allocatableSegments, type AllocSegment } from './hosts'
import { intToIp, ipToInt, parseCidr } from './ip'
import type { DhcpRouteEntry, PlanResult } from './types'

/** 错误定位到的录入字段 */
export type Dhcp121IssueField = 'destination' | 'gateway'

/** 逐条错误定位（重复目的或任一无效条目都会让整体停止生成） */
export interface Dhcp121Issue {
  rowId: string
  /** 错误字段；跨行错误（重复目的）标记在目的字段 */
  field?: Dhcp121IssueField
  message: string
}

/** 客户端网段视图（成功分配的固定 / 自动网段） */
export interface Dhcp121ClientInfo {
  ownerId: string
  kind: 'fixed' | 'auto'
  name: string
  cidr: string
  firstUsable: string
  lastUsable: string
  start: number
  end: number
}

/** 一条通过校验、按 RFC 3442 编码好的路由（已按顺序排序） */
export interface Dhcp121Route {
  rowId: string
  /** 规范目的 CIDR */
  destination: string
  network: number
  prefix: number
  gateway: number
  gatewayIp: string
  /** 该条路由的全部 RFC 3442 字节（前缀 + ceil(前缀/8) 个目的字节 + 4 个下一跳字节） */
  bytes: number[]
  /** 目的网络写入的字节数 = ceil(前缀/8) */
  destByteCount: number
}

/** 面板录入经当前规划重新校验后的视图 */
export interface Dhcp121RowView {
  entry: DhcpRouteEntry
  /** 两栏是否均为空（空行不参与生成、不报错误） */
  blank: boolean
  issues: Dhcp121Issue[]
}

export interface Dhcp121Result {
  /** 可作为客户端网段的全部成功分配网段（按地址升序） */
  choices: Dhcp121ClientInfo[]
  /** 当前选中并仍有效的客户端网段；未选或已失效时为 null */
  client: Dhcp121ClientInfo | null
  rows: Dhcp121RowView[]
  /** 全部错误（含定位信息）；非空时 routes 不可信 */
  issues: Dhcp121Issue[]
  /** 已填写条目数（不含空行） */
  filledCount: number
  /** 通过校验并排序好的路由（仅 canGenerate 时非空） */
  routes: Dhcp121Route[]
  /** 合并后的全部十进制字节（仅 canGenerate 时非空） */
  bytes: number[]
  /** 合并后的 dnsmasq 配置行 dhcp-option=121,...（仅 canGenerate 时非空） */
  optionLine: string
  /** 可生成配置：客户端网段有效、至少一条已填写条目、且无任何错误 */
  canGenerate: boolean
  /** 暂停生成的原因（规划非法 / 无网段 / 未选客户端 / 客户端网段失效） */
  pauseReason?: string
}

function toClientInfo(seg: AllocSegment): Dhcp121ClientInfo {
  return {
    ownerId: seg.ownerId,
    kind: seg.kind,
    name: seg.name,
    cidr: seg.cidr,
    firstUsable: seg.firstUsable,
    lastUsable: seg.lastUsable,
    start: seg.start,
    end: seg.end,
  }
}

/**
 * 按 RFC 3442 编码单条无类静态路由：
 * 前缀长度 + 仅 ceil(prefix/8) 个目的网络字节 + 4 个下一跳字节。
 */
export function encodeClasslessRoute(network: number, prefix: number, gateway: number): number[] {
  const bytes: number[] = [prefix]
  const destByteCount = Math.ceil(prefix / 8)
  for (let i = 0; i < destByteCount; i++) {
    bytes.push((network >>> (24 - i * 8)) & 255)
  }
  for (let i = 0; i < 4; i++) {
    bytes.push((gateway >>> (24 - i * 8)) & 255)
  }
  return bytes
}

/**
 * 用当前规划重新校验全部录入并生成 Option 121 视图。
 * 规划变化后调用方重新执行本函数；录入按稳定行 ID 原样保留，绝不被静默改写。
 */
export function buildDhcpOption121(
  entries: DhcpRouteEntry[],
  clientOwnerId: string | null,
  result: PlanResult,
): Dhcp121Result {
  const choices = allocatableSegments(result).map(toClientInfo)
  const client = choices.find((c) => c.ownerId === clientOwnerId) ?? null

  // 暂停原因：规划非法 / 暂无可选网段 / 未选择 / 已选网段失效（输入保留、结果暂停）
  let pauseReason: string | undefined
  if (result.inputErrors.length > 0) {
    pauseReason =
      '当前规划输入非法（请先修正左侧错误），DHCP Option 121 结果已暂停；已录入的客户端网段与条目不会丢失。'
  } else if (choices.length === 0) {
    pauseReason = '当前没有成功分配的固定或自动网段，暂无可选的客户端网段；已有录入已保留。'
  } else if (clientOwnerId === null) {
    pauseReason = '请先选择一个客户端网段，再录入目的网段与下一跳。'
  } else if (!client) {
    pauseReason =
      '所选客户端网段已失效（需求被删除或当前分配失败），DHCP Option 121 结果已暂停；条目已原样保留，该网段重新成功分配后会自动恢复校验。'
  }

  const rows: Dhcp121RowView[] = []
  const issues: Dhcp121Issue[] = []
  let filledCount = 0

  // 规范目的 CIDR -> 首次出现的行号（1 基，含空行计数，与界面序号一致）
  const firstDestRow = new Map<string, number>()

  entries.forEach((entry, index) => {
    const rowNo = index + 1
    const rowIssues: Dhcp121Issue[] = []
    const destRaw = entry.destination.trim()
    const gwRaw = entry.gateway.trim()
    const blank = destRaw === '' && gwRaw === ''
    if (!blank) filledCount += 1

    // 目的 CIDR：必须存在、合法且为主机位全 0 的规范网络地址（允许 0.0.0.0/0）
    let network = 0
    let prefix = -1
    let canonicalDest = ''
    if (destRaw === '') {
      if (!blank) {
        rowIssues.push({ rowId: entry.id, field: 'destination', message: `第 ${rowNo} 行：缺少目的 CIDR` })
      }
    } else {
      const parsed = parseCidr(destRaw, true)
      if ('error' in parsed) {
        rowIssues.push({ rowId: entry.id, field: 'destination', message: `第 ${rowNo} 行：目的 ${parsed.error}` })
      } else {
        network = parsed.network
        prefix = parsed.prefix
        canonicalDest = `${intToIp(network)}/${prefix}`
        if (firstDestRow.has(canonicalDest)) {
          rowIssues.push({
            rowId: entry.id,
            field: 'destination',
            message: `第 ${rowNo} 行：目的 ${canonicalDest} 与第 ${firstDestRow.get(
              canonicalDest,
            )} 行重复（RFC 3442 不允许重复目的）`,
          })
        } else {
          firstDestRow.set(canonicalDest, rowNo)
        }
      }
    }

    // 下一跳：必须存在且为合法 IPv4；客户端网段有效时还必须是其内的可用主机地址
    if (gwRaw === '') {
      if (!blank) {
        rowIssues.push({ rowId: entry.id, field: 'gateway', message: `第 ${rowNo} 行：缺少下一跳 IPv4` })
      }
    } else {
      const gw = ipToInt(gwRaw)
      if (Number.isNaN(gw)) {
        rowIssues.push({
          rowId: entry.id,
          field: 'gateway',
          message: `第 ${rowNo} 行：下一跳“${gwRaw}”不是合法的 IPv4 地址`,
        })
      } else if (client) {
        const gwIp = intToIp(gw)
        if (gw === client.start) {
          rowIssues.push({
            rowId: entry.id,
            field: 'gateway',
            message: `第 ${rowNo} 行：下一跳 ${gwIp} 是客户端网段 ${client.cidr} 的网络地址，不能作为下一跳`,
          })
        } else if (gw === client.end) {
          rowIssues.push({
            rowId: entry.id,
            field: 'gateway',
            message: `第 ${rowNo} 行：下一跳 ${gwIp} 是客户端网段 ${client.cidr} 的广播地址，不能作为下一跳`,
          })
        } else if (gw < client.start || gw > client.end) {
          rowIssues.push({
            rowId: entry.id,
            field: 'gateway',
            message: `第 ${rowNo} 行：下一跳 ${gwIp} 不在客户端网段 ${client.cidr} 的可用主机范围 ${client.firstUsable} ~ ${client.lastUsable} 内`,
          })
        }
      }
    }

    issues.push(...rowIssues)
    rows.push({ entry, blank, issues: rowIssues })
  })

  const canGenerate = !pauseReason && filledCount > 0 && issues.length === 0
  let routes: Dhcp121Route[] = []
  let bytes: number[] = []
  let optionLine = ''

  if (canGenerate && client) {
    for (const row of rows) {
      if (row.blank) continue
      const destParsed = parseCidr(row.entry.destination.trim(), true)
      if ('error' in destParsed) continue // canGenerate 已保证不会发生
      routes.push({
        rowId: row.entry.id,
        destination: `${intToIp(destParsed.network)}/${destParsed.prefix}`,
        network: destParsed.network,
        prefix: destParsed.prefix,
        gateway: ipToInt(row.entry.gateway.trim()),
        gatewayIp: intToIp(ipToInt(row.entry.gateway.trim())),
        bytes: [],
        destByteCount: Math.ceil(destParsed.prefix / 8),
      })
    }
    // RFC 3442：目的前缀从长到短；前缀相同时按网络地址升序
    routes.sort((a, b) => b.prefix - a.prefix || a.network - b.network)
    routes = routes.map((route) => ({
      ...route,
      bytes: encodeClasslessRoute(route.network, route.prefix, route.gateway),
    }))
    bytes = routes.flatMap((r) => r.bytes)
    optionLine = `dhcp-option=121,${bytes.join(',')}`
  }

  return {
    choices,
    client,
    rows,
    issues,
    filledCount,
    routes,
    bytes,
    optionLine,
    canGenerate,
    ...(pauseReason ? { pauseReason } : {}),
  }
}

/** 下载为 .conf 文件（Blob 方式，纯前端，不经过任何服务器） */
export function downloadDhcpOption121(optionLine: string) {
  const blob = new Blob([`${optionLine}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.href = url
  a.download = `dnsmasq-dhcp-option-121-${stamp}.conf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
