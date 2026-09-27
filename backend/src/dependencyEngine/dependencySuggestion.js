/**
 * Dependency Suggestion & Aggregated Pattern Management Engine
 * Calculates, ranks, and precomputes task sequence dependency suggestions.
 */

const { MIN_PATTERN_SAMPLE_SIZE } = require('./config');
const v4 = () => (require('crypto').randomUUID ? require('crypto').randomUUID() : Math.random().toString(36).substring(2));

/**
 * Retrieves ranked suggested dependency edges among a given set of canonical task IDs.
 * @param {string[]} canonicalTaskIds - Array of canonical task UUIDs
 * @param {Object} dbContext - Database client or in-memory store
 * @param {number} [minSampleSize] - Configurable sample size threshold
 * @returns {Promise<Array<{task_id: string, task_name: string, depends_on_task_id: string, depends_on_name: string, frequency_count: number, confidence: number}>>}
 */
async function getSuggestedDependencies(canonicalTaskIds, dbContext, minSampleSize = MIN_PATTERN_SAMPLE_SIZE) {
  if (!Array.isArray(canonicalTaskIds) || canonicalTaskIds.length < 2) {
    return [];
  }

  // 1. PostgreSQL DB Query
  if (dbContext && typeof dbContext.query === 'function') {
    try {
      const sql = `
        SELECT 
          dp.task_id,
          ct_task.canonical_name AS task_name,
          dp.depends_on_task_id,
          ct_dep.canonical_name AS depends_on_name,
          dp.frequency_count,
          dp.confidence
        FROM dependency_patterns dp
        JOIN canonical_tasks ct_task ON dp.task_id = ct_task.id
        JOIN canonical_tasks ct_dep ON dp.depends_on_task_id = ct_dep.id
        WHERE dp.task_id = ANY($1::uuid[]) 
          AND dp.depends_on_task_id = ANY($1::uuid[])
          AND dp.frequency_count >= $2
        ORDER BY dp.confidence DESC, dp.frequency_count DESC;
      `;
      const res = await dbContext.query(sql, [canonicalTaskIds, minSampleSize]);
      if (res && res.rows) {
        return res.rows.map((r) => ({
          task_id: r.task_id,
          task_name: r.task_name,
          depends_on_task_id: r.depends_on_task_id,
          depends_on_name: r.depends_on_name,
          frequency_count: parseInt(r.frequency_count, 10),
          confidence: parseFloat(parseFloat(r.confidence).toFixed(4))
        }));
      }
    } catch (err) {
      console.warn('[DependencySuggestion] DB query fallback:', err.message);
    }
  }

  // 2. In-Memory Store Fallback
  if (dbContext && Array.isArray(dbContext.dependency_patterns)) {
    const idSet = new Set(canonicalTaskIds);
    const matches = dbContext.dependency_patterns.filter(
      (p) => idSet.has(p.task_id) && idSet.has(p.depends_on_task_id) && p.frequency_count >= minSampleSize
    );

    return matches.map((p) => {
      const tTask = (dbContext.canonical_tasks || []).find((c) => c.id === p.task_id);
      const tDep = (dbContext.canonical_tasks || []).find((c) => c.id === p.depends_on_task_id);
      return {
        task_id: p.task_id,
        task_name: tTask ? tTask.canonical_name : p.task_id,
        depends_on_task_id: p.depends_on_task_id,
        depends_on_name: tDep ? tDep.canonical_name : p.depends_on_task_id,
        frequency_count: p.frequency_count,
        confidence: p.confidence
      };
    }).sort((a, b) => b.confidence - a.confidence);
  }

  return [];
}

/**
 * Commits user-confirmed dependency DAG edges and updates precomputed pattern frequencies.
 * @param {number|string} userId 
 * @param {Array<{task_id: string, depends_on_task_id: string, sequence_order?: number}>} edges 
 * @param {Object} dbContext 
 */
async function confirmDependencies(userId, edges, dbContext) {
  if (!Array.isArray(edges) || edges.length === 0) {
    return { success: true, count: 0 };
  }

  const results = [];

  for (const edge of edges) {
    const { task_id, depends_on_task_id, sequence_order = 1 } = edge;
    if (!task_id || !depends_on_task_id || task_id === depends_on_task_id) continue;

    // 1. PostgreSQL DB operations
    if (dbContext && typeof dbContext.query === 'function') {
      try {
        // Insert into task_dependencies
        await dbContext.query(
          `INSERT INTO task_dependencies (user_id, task_id, depends_on_task_id, sequence_order)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING;`,
          [userId || null, task_id, depends_on_task_id, sequence_order]
        );

        // Upsert into dependency_patterns
        // Recalculates total observations for task_id to compute confidence = frequency_count / total_observations
        const patternUpsertSql = `
          INSERT INTO dependency_patterns (task_id, depends_on_task_id, frequency_count, confidence, last_updated)
          VALUES ($1, $2, 1, 1.0, CURRENT_TIMESTAMP)
          ON CONFLICT (task_id, depends_on_task_id) DO UPDATE 
          SET frequency_count = dependency_patterns.frequency_count + 1,
              last_updated = CURRENT_TIMESTAMP;
        `;
        await dbContext.query(patternUpsertSql, [task_id, depends_on_task_id]);

        // Recalculate confidence scores for all patterns stemming from task_id
        const totalObsSql = `SELECT SUM(frequency_count) AS total FROM dependency_patterns WHERE task_id = $1;`;
        const totalRes = await dbContext.query(totalObsSql, [task_id]);
        const totalObs = totalRes.rows[0]?.total ? parseInt(totalRes.rows[0].total, 10) : 1;

        await dbContext.query(
          `UPDATE dependency_patterns 
           SET confidence = ROUND((frequency_count::numeric / $2::numeric), 4)
           WHERE task_id = $1;`,
          [task_id, totalObs]
        );

        results.push({ task_id, depends_on_task_id, confirmed: true });
      } catch (err) {
        console.warn('[DependencySuggestion] Error confirming dependency edge in DB:', err.message);
      }
    }

    // 2. In-Memory Store Fallback
    if (dbContext && Array.isArray(dbContext.task_dependencies)) {
      dbContext.task_dependencies.push({
        id: v4(),
        user_id: userId,
        task_id,
        depends_on_task_id,
        sequence_order,
        created_at: new Date().toISOString()
      });

      if (!dbContext.dependency_patterns) dbContext.dependency_patterns = [];
      let pat = dbContext.dependency_patterns.find(
        (p) => p.task_id === task_id && p.depends_on_task_id === depends_on_task_id
      );
      if (pat) {
        pat.frequency_count += 1;
        pat.last_updated = new Date().toISOString();
      } else {
        pat = {
          id: v4(),
          task_id,
          depends_on_task_id,
          frequency_count: 1,
          confidence: 1.0,
          last_updated: new Date().toISOString()
        };
        dbContext.dependency_patterns.push(pat);
      }

      // Recalculate confidence for task_id patterns
      const taskPatterns = dbContext.dependency_patterns.filter((p) => p.task_id === task_id);
      const totalCount = taskPatterns.reduce((sum, p) => sum + p.frequency_count, 0);
      taskPatterns.forEach((p) => {
        p.confidence = parseFloat((p.frequency_count / totalCount).toFixed(4));
      });

      results.push({ task_id, depends_on_task_id, confirmed: true });
    }
  }

  return { success: true, count: results.length, confirmed_edges: results };
}

module.exports = {
  getSuggestedDependencies,
  confirmDependencies
};
