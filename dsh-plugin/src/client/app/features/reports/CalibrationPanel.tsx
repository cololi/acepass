import { useQuery } from '@tanstack/react-query'
import {
  fetchEffectCalibration,
  percentOfFraction,
  type CalibrationComparisonOut,
  type CalibrationGroupOut,
  type CalibrationOut,
} from '../../api/client'
import { describeError, useScope } from '../../app/context'

/**
 * C08: 学习效果对比（同一个人，非因果）.
 *
 * The product temptation this panel refuses is one headline number
 * ("你的得分率提升了 X%"): two different question sets, taken at different
 * times, under different exposure and time conditions, with a handful of
 * attempts each, cannot support it. So the panel renders exactly what the
 * server returns — groups with their sample sizes, insufficient groups with no
 * statistics at all, per-group comparability sentences, deltas *with* their
 * sample sizes, spread and caveats, the not-comparable list with reasons, and
 * the server's caveat statements verbatim. Nothing here sums a delta into an
 * "improvement".
 */

const DIFFICULTY_BAND_LABELS: Record<string, string> = {
  score_le_2: '≤2 分',
  score_2_to_5: '2–5 分',
  score_gt_5: '>5 分',
}

const TIMING_LABELS: Record<string, string> = {
  within_limit: '时限内',
  over_limit: '超出时限',
  no_server_timing: '无服务端计时',
  no_configured_limit: '未配置时限',
}

const EXPOSURE_LABELS: Record<string, string> = {
  strictly_independent: '严格独立',
  seen_elsewhere: '已见（系统外/校对/下发）',
  repeated: '重复练习',
  assisted: '辅助作答',
}

function difficultyLabel(value: string): string {
  return DIFFICULTY_BAND_LABELS[value] ?? value
}

function timingLabel(value: string): string {
  return TIMING_LABELS[value] ?? value
}

function exposureLabel(value: string): string {
  return EXPOSURE_LABELS[value] ?? value
}

/** The group key is `type|band|timing|exposure`; when the row is known, use it. */
function groupLabel(key: string, groups: CalibrationGroupOut[]): string {
  const group = groups.find((row) => row.group_key === key)
  if (!group) return key
  const dimensions = group.dimensions
  return `${dimensions.question_type_label} · 难度档 ${difficultyLabel(
    dimensions.difficulty_band,
  )} · ${timingLabel(dimensions.timing_state)} · ${exposureLabel(dimensions.exposure_state)}`
}

function statisticsLine(group: CalibrationGroupOut): string {
  const statistics = group.statistics
  if (!statistics) return ''
  return `确认样本均值 ${percentOfFraction(statistics.mean_confirmed_fraction)}（中位数 ${percentOfFraction(
    statistics.median_confirmed_fraction,
  )}，离散度 ${statistics.spread_stdev}，范围 ${percentOfFraction(
    statistics.min_confirmed_fraction,
  )}–${percentOfFraction(statistics.max_confirmed_fraction)}）`
}

function ComparisonCard({
  row,
  groups,
}: {
  row: CalibrationComparisonOut
  groups: CalibrationGroupOut[]
}) {
  const delta = row.delta
  if (!delta) return null
  const deltaValue = Number(delta.delta)
  const deltaLabel = Number.isFinite(deltaValue)
    ? `${deltaValue > 0 ? '+' : ''}${deltaValue.toFixed(4)}（${deltaValue > 0 ? '+' : ''}${(
        deltaValue * 100
      ).toFixed(1)} 个百分点）`
    : delta.delta
  return (
    <div className="card surface-subtle" data-testid="calibration-comparison">
      <p className="small" style={{ marginTop: 0 }}>
        <strong>组 A</strong>：{groupLabel(row.group_a, groups)} · 样本 {delta.sample_size.group_a} · 均值{' '}
        {percentOfFraction(delta.group_a_mean)} · 离散度 {delta.spread.group_a_stdev}
      </p>
      <p className="small">
        <strong>组 B</strong>：{groupLabel(row.group_b, groups)} · 样本 {delta.sample_size.group_b} · 均值{' '}
        {percentOfFraction(delta.group_b_mean)} · 离散度 {delta.spread.group_b_stdev}
      </p>
      <p className="small" style={{ marginBottom: 4 }}>
        <strong>组间差值（B − A，不是“提升”，不代表因果）</strong>：{deltaLabel}
      </p>
      <p className="tiny muted" style={{ marginBottom: 4 }}>
        指标：{delta.metric}；差值仅来自确认判分，样本数见上。
      </p>
      {delta.caveats.length ? (
        <ul className="small muted" style={{ marginBottom: 0 }}>
          {delta.caveats.map((caveat, index) => (
            <li key={index}>{caveat}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function CalibrationPanel({
  projectId,
  subjectId,
}: {
  projectId: string | null
  subjectId: string | null
}) {
  const { currentSubject } = useScope()
  const query = useQuery({
    queryKey: ['calibration', projectId, subjectId],
    queryFn: () => fetchEffectCalibration(projectId as string, subjectId),
    enabled: Boolean(projectId),
  })

  // An error clears the panel: a stale set of numbers must never stay on screen
  // while the server is saying it cannot be computed.
  const data: CalibrationOut | null = query.isError ? null : (query.data ?? null)
  const minimum = data?.minimum_group_sample ?? 5
  const comparableDeltas = (data?.comparisons ?? []).filter(
    (row) => row.comparable && row.delta !== null,
  )
  const subjectName = currentSubject && currentSubject.id === subjectId ? currentSubject.name : null

  return (
    <div className="card" data-testid="calibration-panel">
      <h2>效果对比（同一个人，非因果）</h2>
      <p className="small muted">
        按题型、难度档、时限条件与暴露情况分组，只统计已确认判分的作答
        {subjectName ? `（科目：${subjectName}）` : ''}。
        确认样本少于 {minimum} 的组不展示任何统计量，也不参与比较；组间差值只是同一个人的两组观察值之差，
        不是因果效应，也不代表学习提升。
      </p>

      {query.isLoading ? <p className="small muted">计算中…</p> : null}
      {query.isError ? <div className="notice danger">{describeError(query.error)}</div> : null}

      {data ? (
        <>
          <p className="small">
            参与统计的作答 {data.grouping.attempts_in_scope} 次 · 分组 {data.group_count} 个 ·
            达到样本门槛的组 {data.comparable_group_count} 个 · 可给出的组间差值 {data.comparable_pair_count} 对
            {data.grouping.hidden_verification_attempts
              ? ` · 另有 ${data.grouping.hidden_verification_attempts} 次作答属于尚未结束的验证/考试，未计入`
              : ''}
            {data.grouping.hidden_verification_content_attempts
              ? ` · 另有 ${data.grouping.hidden_verification_content_attempts} 次与进行中的验证内容同源，未计入`
              : ''}
          </p>

          <h3>分组（题型 / 难度档 / 时限 / 暴露状态 / 样本数 / 状态）</h3>
          {data.groups.length === 0 ? (
            <p className="small muted">还没有可用于效果对比的已确认作答：此处不给出任何统计量。</p>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>题型</th>
                    <th>难度档</th>
                    <th>时限</th>
                    <th>暴露状态</th>
                    <th>样本数</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((group) => (
                    <tr key={group.group_key} data-testid="calibration-group-row">
                      <td className="small">{group.dimensions.question_type_label}</td>
                      <td className="small">{difficultyLabel(group.dimensions.difficulty_band)}</td>
                      <td className="small">{timingLabel(group.dimensions.timing_state)}</td>
                      <td className="small">{exposureLabel(group.dimensions.exposure_state)}</td>
                      <td className="small">
                        {group.sample_size}（确认 {group.confirmed_sample_size}）
                      </td>
                      <td className="small">
                        {group.status === 'ok' ? (
                          <span className="pill ok">达到样本门槛</span>
                        ) : (
                          <span className="pill warn" data-testid="calibration-insufficient">
                            样本不足（少于 {minimum}）
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.groups.map((group) => (
            <div key={`${group.group_key}-note`} style={{ marginTop: 8 }}>
              <p className="small" style={{ marginBottom: 2 }}>
                <strong>{groupLabel(group.group_key, data.groups)}</strong>
                {group.status === 'ok' ? `：${statisticsLine(group)}` : ''}
              </p>
              <p className="tiny muted" style={{ marginBottom: 2 }}>
                {group.comparability}
              </p>
              {group.exclusions.reasons.length ? (
                <p className="tiny muted" style={{ marginBottom: 2 }}>
                  未进入确认样本的 {group.exclusions.attempts_without_confirmed_score} 次：
                  {group.exclusions.reasons
                    .map((reason) => `${reason.message}（${reason.attempt_count}）`)
                    .join('；')}
                </p>
              ) : null}
            </div>
          ))}

          <h3>可比较的组间差值（{comparableDeltas.length}）</h3>
          {comparableDeltas.length === 0 ? (
            <p className="small muted">
              没有同时达到样本门槛、且题型/难度档/时限条件相同的两组，因此不给出任何组间差值。
            </p>
          ) : (
            comparableDeltas.map((row) => (
              <ComparisonCard key={`${row.group_a}↔${row.group_b}`} row={row} groups={data.groups} />
            ))
          )}

          <h3>不可比较（{data.not_comparable.length}）</h3>
          {data.not_comparable.length === 0 ? (
            <p className="small muted">没有因条件不同或样本不足而不可比较的分组。</p>
          ) : (
            <ul className="small">
              {data.not_comparable.map((row, index) => (
                <li key={`${row.group_key}-${index}`} data-testid="calibration-not-comparable">
                  {groupLabel(row.group_key, data.groups)}：{row.message ?? row.code}
                </li>
              ))}
            </ul>
          )}

          <div data-testid="calibration-caveats" style={{ marginTop: 10 }}>
            <h3>口径与声明（服务器原文）</h3>
            <p className="small muted">
              难度代理：{data.grouping.difficulty_proxy}。{data.grouping.difficulty_proxy_note}
            </p>
            <p className="small muted">{data.grouping.timing_note}</p>
            <p className="small muted">{data.grouping.exposure_note}</p>
            <ul className="small">
              {data.caveats.statements.map((statement, index) => (
                <li key={index}>{statement}</li>
              ))}
            </ul>
            <p className="small" style={{ marginBottom: 0 }}>
              本报告不作出因果论断（causal_claim={String(data.caveats.claims.causal_claim)}），
              也不声称学习提升（improvement_claim={String(data.caveats.claims.improvement_claim)}）；
              每组至少需要 {data.caveats.minimum_group_sample} 个确认样本才展示统计量。
            </p>
          </div>

          {data.exclusions.reasons.length ? (
            <p className="tiny muted" style={{ marginTop: 8 }}>
              全项目被排除在统计之外的作答：{data.exclusions.attempts_in_scope} 次在范围内；
              {data.exclusions.reasons
                .map((reason) => `${reason.message}（${reason.attempt_count}）`)
                .join('；')}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
