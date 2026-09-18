import { useMemo, useState } from 'react'
import { buildDhcpOption121, downloadDhcpOption121 } from '../lib/dhcpOption121'
import type { DhcpRouteEntry, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  entries: DhcpRouteEntry[]
  clientOwnerId: string | null
  onEntriesChange: (next: DhcpRouteEntry[]) => void
  onClientChange: (ownerId: string | null) => void
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

let routeCounter = 0
function routeUid(): string {
  routeCounter += 1
  return `opt121-${Date.now()}-${routeCounter}`
}

/** 复制到剪贴板；非安全上下文（无 navigator.clipboard）时回退到临时 textarea */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到回退方案
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function DhcpOption121Panel({
  result,
  entries,
  clientOwnerId,
  onEntriesChange,
  onClientChange,
}: Props) {
  const [copied, setCopied] = useState(false)

  // 规划变化后实时重算（result 变化即重新执行）；录入按稳定行 ID 原样保留
  const view = useMemo(
    () => buildDhcpOption121(entries, clientOwnerId, result),
    [entries, clientOwnerId, result],
  )

  const issueKey = (rowId: string, field: 'destination' | 'gateway') =>
    view.rows.find((r) => r.entry.id === rowId)?.issues.some((i) => i.field === field) ?? false

  function patchEntry(id: string, patch: Partial<Omit<DhcpRouteEntry, 'id'>>) {
    setCopied(false)
    onEntriesChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  function removeEntry(id: string) {
    setCopied(false)
    onEntriesChange(entries.filter((e) => e.id !== id))
  }

  async function handleCopy() {
    if (!view.canGenerate) return
    const ok = await copyText(view.optionLine)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  const invalid = result.inputErrors.length > 0
  const selectDisabled = invalid || view.choices.length === 0

  return (
    <div className="panel dhcp-panel">
      <h2>⑦ DHCP Option 121（无类静态路由 / RFC 3442）</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        选择一个<strong>当前成功分配</strong>的固定 / 自动网段作为<strong>客户端网段</strong>，
        录入多条「目的 CIDR → 下一跳 IPv4」。目的必须是<strong>规范网络地址</strong>（主机位全 0，允许
        <code className="mono">0.0.0.0/0</code> 默认路由）；下一跳必须是客户端网段内的
        <strong>可用主机地址</strong>（不能是网络地址或广播地址）。系统按
        <strong>目的前缀从长到短、网络地址升序</strong>生成 RFC 3442 字节：每写入前缀长度后仅写
        <code className="mono">⌈前缀/8⌉</code> 个目的网络字节，再写 4 个下一跳字节；
        输出可直接用于 dnsmasq 的 <code className="mono">dhcp-option=121</code>。
        <strong>重复目的或任一条目无效都会停止生成</strong>并逐行定位错误。
      </p>

      {/* 客户端网段选择 */}
      <div className="dhcp-client-row">
        <label className="field-label" htmlFor="dhcp121-client">
          客户端网段（DHCP 客户端所在网段，下一跳必须位于其内）
        </label>
        <select
          id="dhcp121-client"
          className="dhcp-client-select"
          value={view.client ? clientOwnerId ?? '' : ''}
          disabled={selectDisabled}
          onChange={(e) => {
            setCopied(false)
            onClientChange(e.target.value === '' ? null : e.target.value)
          }}
        >
          <option value="">— 请选择客户端网段 —</option>
          {view.choices.map((c) => (
            <option key={c.ownerId} value={c.ownerId}>
              {`［${KIND_LABEL[c.kind]}］${c.name} ${c.cidr}（可用 ${c.firstUsable} ~ ${c.lastUsable}）`}
            </option>
          ))}
        </select>
        {view.client && (
          <span className="dhcp-client-meta mono">
            {view.client.cidr} · 可用主机 {view.client.firstUsable} ~ {view.client.lastUsable}
          </span>
        )}
        {clientOwnerId !== null && !view.client && !invalid && view.choices.length > 0 && (
          <span className="dhcp-client-gone">
            原客户端网段已失效（需求被删除或当前分配失败），请重新选择；下方条目已保留。
          </span>
        )}
      </div>

      {/* 暂停提示 */}
      {view.pauseReason && <div className="summary-disabled-note">{view.pauseReason}</div>}

      {/* 错误总览（明确定位：行号 + 字段 + 原因） */}
      {view.issues.length > 0 && (
        <div className="error-list dhcp-error-list">
          <strong>存在 {view.issues.length} 个条目问题，已停止生成 Option 121：</strong>
          <ul>
            {view.issues.map((issue, i) => (
              <li key={i}>
                {issue.message}
                {issue.field ? `（${issue.field === 'destination' ? '目的 CIDR' : '下一跳 IPv4'}）` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 条目录入表 */}
      <div className="dhcp-route-head">
        <span className="dhcp-col-no">#</span>
        <span className="dhcp-col-dest">目的 CIDR（规范网络地址）</span>
        <span className="dhcp-col-gw">下一跳 IPv4（客户端网段内可用主机）</span>
        <span className="dhcp-col-status">校验 / RFC 3442 字节</span>
        <span className="dhcp-col-del" />
      </div>

      {entries.length === 0 && <p className="summary-empty">暂无条目，点击下方「+ 添加路由条目」开始录入。</p>}

      {entries.map((entry, index) => {
        const row = view.rows.find((r) => r.entry.id === entry.id)
        const route = view.routes.find((r) => r.rowId === entry.id)
        const destBad = issueKey(entry.id, 'destination')
        const gwBad = issueKey(entry.id, 'gateway')
        const rowIssue = row?.issues[0]
        return (
          <div className="dhcp-route-row" key={entry.id}>
            <span className="dhcp-col-no mono">{index + 1}</span>
            <div className="dhcp-col-dest">
              <input
                type="text"
                className={destBad ? 'is-invalid' : ''}
                placeholder="例如 10.0.0.0/24 或 0.0.0.0/0"
                value={entry.destination}
                onChange={(e) => patchEntry(entry.id, { destination: e.target.value })}
              />
            </div>
            <div className="dhcp-col-gw">
              <input
                type="text"
                className={`mono${gwBad ? ' is-invalid' : ''}`}
                placeholder="例如 192.168.10.1"
                value={entry.gateway}
                onChange={(e) => patchEntry(entry.id, { gateway: e.target.value })}
              />
            </div>
            <div className="dhcp-col-status">
              {view.canGenerate && route ? (
                <span className="dhcp-bytes mono" title="该条路由的 RFC 3442 字节（十进制）">
                  {route.bytes.join(',')}
                </span>
              ) : rowIssue ? (
                <span className="host-invalid-tag">{rowIssue.message.replace(/^第 \d+ 行：/, '')}</span>
              ) : (
                <span className="dhcp-status-pending">—</span>
              )}
            </div>
            <div className="dhcp-col-del">
              <button className="icon" title="删除该条目" onClick={() => removeEntry(entry.id)}>
                ✕
              </button>
            </div>
          </div>
        )
      })}

      <div className="btn-row">
        <button
          onClick={() =>
            onEntriesChange([...entries, { id: routeUid(), destination: '', gateway: '' }])
          }
        >
          + 添加路由条目
        </button>
      </div>

      {/* 生成结果 */}
      {view.canGenerate && (
        <div className="dnsmasq-box dhcp-result-box">
          <div className="dnsmasq-head">
            <h3>dnsmasq 配置（dhcp-option=121）</h3>
            <div className="dnsmasq-actions">
              <button onClick={handleCopy} title="复制合并后的 dhcp-option=121 配置行">
                {copied ? '✓ 已复制' : '📋 复制'}
              </button>
              <button className="primary" onClick={() => downloadDhcpOption121(view.optionLine)} title="下载为 dnsmasq 配置文件（.conf）">
                ⬇ 下载 .conf
              </button>
            </div>
          </div>

          <div className="table-scroll">
            <table className="dhcp-route-table">
              <thead>
                <tr>
                  <th>顺序</th>
                  <th>目的 CIDR</th>
                  <th>前缀长度</th>
                  <th>目的字节数 ⌈P/8⌉</th>
                  <th>下一跳 IPv4</th>
                  <th>RFC 3442 字节（十进制，每条）</th>
                </tr>
              </thead>
              <tbody>
                {view.routes.map((route, i) => (
                  <tr key={route.rowId}>
                    <td className="mono">{i + 1}</td>
                    <td className="mono">{route.destination}</td>
                    <td className="mono">{route.prefix}</td>
                    <td className="mono">{route.destByteCount}</td>
                    <td className="mono">{route.gatewayIp}</td>
                    <td className="mono dhcp-bytes">{route.bytes.join(',')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="dnsmasq-hint" style={{ marginTop: 10 }}>
            已按<strong>目的前缀从长到短、网络地址升序</strong>排列 {view.routes.length} 条路由，
            合并后共 <strong>{view.bytes.length}</strong> 个字节，可直接追加到 dnsmasq 配置后重新加载：
          </p>
          <pre className="mono dnsmasq-output">{view.optionLine}</pre>
        </div>
      )}
    </div>
  )
}
