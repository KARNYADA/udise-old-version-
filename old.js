/* USAGE:
 *  1. UDISE+ portal login → Student Movement and Progression
 *  2. Class+Section select → "Go" → student list dikhe
 *  3. F12 → Console → ye pura code paste → Enter
 *  4. CSV paste → "Load CSV" → "🔍 Match Check" → "▶ Start"
 * ============================================================================ */

(function UDISEAutoFiller() {
  'use strict';

  document.getElementById('udise-filler-panel')?.remove();

  /* ------------------------------ CONFIG --------------------------------- */
  const CFG = {
    delayAfterSelect:      350,
    delayAfterFill:        350,
    delayAfterUpdate:      400,
    delayAfterOkay:        700,
    delayBetweenStudents: 1000,
    modalWaitTimeout:     8000,
    statusVerifyTimeout:  5000,
    okayWaitTimeout:      3000,

    defaults: {
      progressionStatusPattern: /Promoted\s*\(?\s*by\s*Examination\s*\)?/i,
      schoolingStatusPattern:   /Studying\s*in\s*Same\s*School/i,
      section:                  'A',
    },

    // Father name prefix strip (before comparison)
    fatherPrefixRegex: /^(SHRI|SH\.?|SRI|MR\.?|LATE\.?|LT\.?|S\/O)\s+/i,
  };

  /* ------------------------------- STATE --------------------------------- */
  const state = {
    studentMap: new Map(),     // normName → Array<csvRow>  (handles duplicates)
    usedCSVRows: new WeakSet(),
    isRunning:  false,
    isPaused:   false,
    shouldStop: false,
    stats: { total: 0, done: 0, alreadyDone: 0, notFound: 0, mismatched: 0, failed: 0 },
    failures: [],
    csvHasFather: false,
  };

  /* ----------------------------- UTILITIES ------------------------------- */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const normalize = (s) =>
    String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

  const normalizeFather = (s) => {
    let n = normalize(s);
    // Strip prefixes (SHRI, SH., MR. etc.) — multiple times in case "SHRI SH. X"
    let prev;
    do { prev = n; n = n.replace(CFG.fatherPrefixRegex, '').trim(); }
    while (n !== prev);
    return n;
  };

  const checkPause = async () => {
    while (state.isPaused && !state.shouldStop) await sleep(200);
  };

  const setInputValue = (input, value) => {
    const proto  = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, String(value));
    ['input', 'change', 'blur'].forEach(evt =>
      input.dispatchEvent(new Event(evt, { bubbles: true }))
    );
  };

  const setSelectByText = (select, pattern, friendlyName) => {
    const option = Array.from(select.options).find(o => {
      const text = (o.text || '').trim();
      if (!text || /^select$/i.test(text)) return false;
      return pattern instanceof RegExp ? pattern.test(text) : (text === pattern);
    });
    if (!option) {
      const available = Array.from(select.options)
        .map(o => `"${o.text.trim()}"`).join(', ');
      throw new Error(`${friendlyName}: matching option nahi mila. Available: ${available}`);
    }
    const proto  = window.HTMLSelectElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(select, option.value);
    Array.from(select.options).forEach(o => o.selected = (o === option));
    select.selectedIndex = option.index;
    ['input', 'change', 'blur'].forEach(evt =>
      select.dispatchEvent(new Event(evt, { bubbles: true }))
    );
    return option.text.trim();
  };

  const waitFor = async (predicate, timeout = 5000, interval = 100) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = predicate(); if (v) return v; } catch (_) {}
      await sleep(interval);
    }
    return null;
  };

  // Lenient numeric comparison (handles "92.58" vs 92.58 vs "92.580")
  const numEq = (a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (isNaN(na) || isNaN(nb)) return false;
    return Math.abs(na - nb) < 0.01;
  };

  /* --------------------------- CSV PARSING ------------------------------- */
  const parseCSV = (text) => {
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV mein header + kam se kam 1 row honi chahiye');

    const headers = lines[0].split(',').map(h => h.trim());
    const need = ['StudentName', 'Attendance', 'Percentage'];
    for (const col of need)
      if (!headers.includes(col)) throw new Error(`Required column missing: "${col}"`);

    state.csvHasFather = headers.includes('FatherName');

    return lines.slice(1).map((line, i) => {
      const vals = line.split(',').map(v => v.trim());
      const row  = { _line: i + 2 };
      headers.forEach((h, j) => row[h] = vals[j] || '');
      return row;
    });
  };

  /* --------------------------- DOM HELPERS ------------------------------- */
  const findStudentRows = () =>
    Array.from(document.querySelectorAll('tr')).filter(tr => {
      const t = tr.textContent || '';
      return t.includes('Student Name:') && t.includes('PEN');
    });

  const extractStudentName = (row) => {
    const labels = row.querySelectorAll('b, strong');
    for (const el of labels) {
      const prev = (el.previousSibling && el.previousSibling.textContent) || '';
      if (/Student\s*Name\s*:?\s*$/i.test(prev)) return normalize(el.textContent);
    }
    const m = (row.textContent || '').match(
      /Student\s*Name\s*:\s*([A-Z][A-Z\s.]*?)\s*PEN/i
    );
    return m ? normalize(m[1]) : null;
  };

  const extractFatherName = (row) => {
    // Method 1: look for <b>/<strong> right after "Father's Name:" label
    const labels = row.querySelectorAll('b, strong');
    for (const el of labels) {
      const prev = (el.previousSibling && el.previousSibling.textContent) || '';
      if (/Father['']?s\s*Name\s*:?\s*$/i.test(prev)) return normalize(el.textContent);
    }
    // Method 2: regex on full text
    const m = (row.textContent || '').match(
      /Father['']?s\s*Name\s*:\s*([A-Z][A-Z\s.\/]*?)\s*Mother/i
    );
    return m ? normalize(m[1]) : null;
  };

  const getRowStatus = (row) => {
    const t = row.textContent || '';
    if (/\bDone\b/.test(t))    return 'Done';
    if (/\bPending\b/.test(t)) return 'Pending';
    return 'Unknown';
  };

  const findRowInputs = (row) =>
    Array.from(row.querySelectorAll('input')).filter(i => {
      const t = (i.type || '').toLowerCase();
      return (t === '' || t === 'text' || t === 'number') && !i.disabled && i.offsetParent !== null;
    });

  const classifySelects = (row) => {
    const selects = Array.from(row.querySelectorAll('select')).filter(s => !s.disabled);
    const result  = { progression: null, schooling: null, section: null };
    for (const sel of selects) {
      const opts = Array.from(sel.options).map(o => (o.text || '').trim());
      if (!result.progression && opts.some(o => /Promoted.*by.*Examination/i.test(o))) {
        result.progression = sel; continue;
      }
      if (!result.schooling && opts.some(o => /Studying.*Same.*School/i.test(o))) {
        result.schooling = sel; continue;
      }
      if (!result.section && opts.length <= 30 &&
          opts.filter(o => o && !/^select$/i.test(o)).every(o => /^[A-Z0-9 ]{1,4}$/i.test(o))) {
        result.section = sel; continue;
      }
    }
    return result;
  };

  const findUpdateButton = (row) =>
    Array.from(row.querySelectorAll('button')).find(
      b => /^update$/i.test(b.textContent.trim()) && !b.disabled
    );

  const findSuccessModal = () => {
    const all = document.querySelectorAll('div, p, span, h1, h2, h3, h4');
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (/student.*details.*has\s*been.*updated.*successfully/i.test(t) &&
          el.offsetParent !== null) return el;
    }
    return null;
  };

  const findOkayButton = () =>
    Array.from(document.querySelectorAll('button')).find(b => {
      const t = b.textContent.trim();
      return /^(okay|ok)$/i.test(t) && b.offsetParent !== null && !b.disabled;
    });

  /* ------------------ MATCHING LOGIC (the brain) ------------------------- */
  /**
   * Returns one of:
   *   { ok: true, csvRow }
   *   { ok: false, reason: 'not-in-csv' | 'father-mismatch' | 'ambiguous' | 'all-used',
   *     details: '...' }
   */
  const matchStudent = (pageName, pageFather) => {
    const candidates = (state.studentMap.get(pageName) || [])
      .filter(c => !state.usedCSVRows.has(c));

    if (candidates.length === 0) {
      const wasInCSV = state.studentMap.has(pageName);
      return {
        ok: false,
        reason: wasInCSV ? 'all-used' : 'not-in-csv',
        details: wasInCSV
          ? 'CSV mein hai par sare entries already kisi aur student ke liye use ho gaye'
          : 'CSV mein ye naam nahi hai',
      };
    }

    // CSV mein FatherName column hi nahi hai → name-only mode
    if (!state.csvHasFather) {
      if (candidates.length === 1) return { ok: true, csvRow: candidates[0] };
      return {
        ok: false, reason: 'ambiguous',
        details: `CSV mein "${pageName}" naam ke ${candidates.length} entries hai. FatherName column add karein to disambiguate ho jayega.`,
      };
    }

    // Father verification mode
    if (!pageFather) {
      return { ok: false, reason: 'father-mismatch',
        details: 'Page se father name extract nahi hua' };
    }

    const pageFatherN = normalizeFather(pageFather);
    const matches = candidates.filter(c =>
      normalizeFather(c.FatherName) === pageFatherN
    );

    if (matches.length === 1) return { ok: true, csvRow: matches[0] };
    if (matches.length === 0) {
      const csvFathers = candidates.map(c => `"${c.FatherName}"`).join(', ');
      return {
        ok: false, reason: 'father-mismatch',
        details: `Page father="${pageFather}" | CSV father(s)=${csvFathers}`,
      };
    }
    return {
      ok: false, reason: 'ambiguous',
      details: `${matches.length} CSV entries name+father dono se match ho rahe hai`,
    };
  };

  /* ------------------- CORE: PROCESS ONE STUDENT ROW --------------------- */
  const processStudent = async (row, data) => {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(450);

    row.style.transition      = 'background-color 0.3s';
    row.style.backgroundColor = '#fff3cd';

    const dd = classifySelects(row);
    if (!dd.progression) throw new Error('Progression Status dropdown nahi mila');
    if (!dd.schooling)   throw new Error('Schooling Status dropdown nahi mila');
    if (!dd.section)     throw new Error('Section dropdown nahi mila');

    log(`  → Progression Status select...`);
    const progSet = setSelectByText(dd.progression,
      CFG.defaults.progressionStatusPattern, 'Progression Status');
    log(`     ✓ "${progSet}"`);
    await sleep(CFG.delayAfterSelect);

    const inputs = findRowInputs(row);
    if (inputs.length < 2)
      throw new Error(`Inputs nahi mile (sirf ${inputs.length} mile, 2 chahiye)`);
    const [marksInput, daysInput] = inputs;

    log(`  → Marks: ${data.Percentage}%`);
    setInputValue(marksInput, data.Percentage);
    await sleep(CFG.delayAfterFill);

    log(`  → Days:  ${data.Attendance}`);
    setInputValue(daysInput, data.Attendance);
    await sleep(CFG.delayAfterFill);

    log(`  → Schooling Status select...`);
    const schSet = setSelectByText(dd.schooling,
      CFG.defaults.schoolingStatusPattern, 'Schooling Status');
    log(`     ✓ "${schSet}"`);
    await sleep(CFG.delayAfterSelect);

    log(`  → Section select...`);
    const secPattern = new RegExp(`^\\s*${CFG.defaults.section}\\s*$`, 'i');
    const secSet = setSelectByText(dd.section, secPattern, 'Section');
    log(`     ✓ "${secSet}"`);
    await sleep(CFG.delayAfterSelect);

    /* ---- PRE-FLIGHT CHECK ---- */
    log(`  → Pre-flight check...`);
    if (!numEq(marksInput.value, data.Percentage))
      throw new Error(`Marks set nahi hua. Expected="${data.Percentage}" Got="${marksInput.value}"`);
    if (!numEq(daysInput.value, data.Attendance))
      throw new Error(`Days set nahi hua. Expected="${data.Attendance}" Got="${daysInput.value}"`);

    const progNow = (dd.progression.options[dd.progression.selectedIndex]?.text || '').trim();
    const schNow  = (dd.schooling.options[dd.schooling.selectedIndex]?.text || '').trim();
    const secNow  = (dd.section.options[dd.section.selectedIndex]?.text || '').trim();
    if (!CFG.defaults.progressionStatusPattern.test(progNow))
      throw new Error(`Progression verify fail: "${progNow}"`);
    if (!CFG.defaults.schoolingStatusPattern.test(schNow))
      throw new Error(`Schooling verify fail: "${schNow}"`);
    if (!secPattern.test(secNow))
      throw new Error(`Section verify fail: "${secNow}"`);
    log(`     ✓ Sab verified`);

    /* ---- Update + Modal ---- */
    const updateBtn = findUpdateButton(row);
    if (!updateBtn) throw new Error('Update button nahi mila ya disabled hai');
    log(`  → Update click...`);
    updateBtn.click();
    await sleep(CFG.delayAfterUpdate);

    const modal = await waitFor(findSuccessModal, CFG.modalWaitTimeout);
    if (!modal) throw new Error('Success modal timeout (8s) — validation fail hua ho sakta hai');

    const okayBtn = await waitFor(findOkayButton, CFG.okayWaitTimeout);
    if (!okayBtn) throw new Error('Okay button nahi mila');
    log(`  → Okay click...`);
    okayBtn.click();
    await sleep(CFG.delayAfterOkay);

    const ok = await waitFor(() => getRowStatus(row) === 'Done', CFG.statusVerifyTimeout);
    if (ok) {
      row.style.backgroundColor = '#d4edda';
      log(`  ✓ DONE`, 'success');
    } else {
      row.style.backgroundColor = '#d1ecf1';
      log(`  ⚠ Status verify nahi hua, lekin Okay click ho gaya`, 'warn');
    }
  };

  /* ------------------------- MATCH CHECK (DRY RUN) ----------------------- */
  const runMatchCheck = () => {
    if (state.studentMap.size === 0) {
      log('❌ Pehle CSV load karein', 'error'); return;
    }
    const rows = findStudentRows();
    log('━━━ 🔍 MATCH CHECK ━━━', 'info');
    log(`Page pe ${rows.length} | CSV mein ${countCSVEntries()}`, 'info');
    log(`Father verification: ${state.csvHasFather ? 'ON' : 'OFF (FatherName column nahi)'}`, 'info');

    const willProcess = [], alreadyDone = [], skipReasons = [];
    const usedSimulated = new Set();

    for (const row of rows) {
      const name   = extractStudentName(row);
      const father = extractFatherName(row);
      const status = getRowStatus(row);
      if (!name) continue;

      if (status === 'Done') { alreadyDone.push(name); continue; }

      // Simulate matching (not modifying real usedCSVRows)
      const candidates = (state.studentMap.get(name) || []).filter(c => !usedSimulated.has(c));
      let result;
      if (candidates.length === 0) {
        result = { ok: false, reason: state.studentMap.has(name) ? 'all-used' : 'not-in-csv' };
      } else if (!state.csvHasFather) {
        result = candidates.length === 1
          ? { ok: true, csvRow: candidates[0] }
          : { ok: false, reason: 'ambiguous', details: `${candidates.length} duplicates in CSV` };
      } else {
        const pf = normalizeFather(father || '');
        const m  = candidates.filter(c => normalizeFather(c.FatherName) === pf);
        if (m.length === 1)      result = { ok: true, csvRow: m[0] };
        else if (m.length === 0) result = { ok: false, reason: 'father-mismatch',
          details: `Page="${father || '(none)'}" CSV=[${candidates.map(c => c.FatherName).join(' | ')}]` };
        else                     result = { ok: false, reason: 'ambiguous' };
      }

      if (result.ok) {
        usedSimulated.add(result.csvRow);
        willProcess.push(`${name}  (father: ${father || '?'})`);
      } else {
        skipReasons.push({ name, father: father || '(none)', reason: result.reason, details: result.details });
      }
    }

    log(`✓ Will process: ${willProcess.length}`, 'success');
    if (willProcess.length && willProcess.length <= 30)
      willProcess.forEach(n => log(`     • ${n}`, 'info'));

    log(`⏭ Already Done: ${alreadyDone.length}`);

    if (skipReasons.length) {
      log(`❌ Will SKIP: ${skipReasons.length}`, 'warn');
      skipReasons.forEach(s => {
        const r = ({
          'not-in-csv':       'CSV mein nahi hai',
          'father-mismatch':  'Father name mismatch',
          'ambiguous':        'Ambiguous (multiple matches)',
          'all-used':         'Sare CSV entries use ho chuke',
        })[s.reason] || s.reason;
        log(`     • ${s.name} (father: ${s.father}) — ${r}`, 'warn');
        if (s.details) log(`         ${s.details}`, 'warn');
      });
    }

    // CSV mein hai par page pe nahi
    const pageNames = new Set();
    rows.forEach(r => { const n = extractStudentName(r); if (n) pageNames.add(n); });
    const orphanCSV = [];
    for (const n of state.studentMap.keys()) if (!pageNames.has(n)) orphanCSV.push(n);
    if (orphanCSV.length) {
      log(`⚠ CSV mein hai par page pe nahi: ${orphanCSV.length}`, 'warn');
      orphanCSV.forEach(n => log(`     • ${n}`, 'warn'));
    }
    log('━━━━━━━━━━━━━━━━━━━━━━', 'info');
  };

  const countCSVEntries = () => {
    let c = 0;
    for (const arr of state.studentMap.values()) c += arr.length;
    return c;
  };

  /* ------------------------- AUTOMATION LOOP ----------------------------- */
  const runAutomation = async () => {
    state.isRunning  = true;
    state.shouldStop = false;
    state.failures   = [];
    state.usedCSVRows = new WeakSet();   // reset
    state.stats = { total: 0, done: 0, alreadyDone: 0, notFound: 0, mismatched: 0, failed: 0 };
    updateUI();

    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
    log('🚀 Automation start...', 'info');
    log(`   Section default: "${CFG.defaults.section}"`, 'info');
    log(`   Father verification: ${state.csvHasFather ? 'ON ✓' : 'OFF'}`, 'info');

    const rows = findStudentRows();
    state.stats.total = rows.length;
    log(`Page pe ${rows.length} student rows | CSV mein ${countCSVEntries()} entries`, 'info');

    if (rows.length === 0) {
      log('❌ Koi row nahi mila. Class+Section select karke "Go" dabaya?', 'error');
      state.isRunning = false; updateUI(); return;
    }

    for (let i = 0; i < rows.length; i++) {
      if (state.shouldStop) { log('⏹ Stopped by user', 'warn'); break; }
      await checkPause();

      const row    = rows[i];
      const name   = extractStudentName(row);
      const father = extractFatherName(row);
      const label  = `[${i + 1}/${rows.length}]`;

      log(`${label} ${name || '(name extract failed)'} ${father ? '(F: ' + father + ')' : ''}`);

      if (!name) {
        log(`  ⚠ Name extract nahi hua → SKIP`, 'warn');
        row.style.backgroundColor = '#f8d7da';
        state.stats.failed++;
        state.failures.push({ index: i + 1, reason: 'name extract failed' });
        updateUI(); continue;
      }

      if (getRowStatus(row) === 'Done') {
        log(`  ⏭ Already Done — SKIP`);
        row.style.backgroundColor = '#e2e3e5';
        state.stats.alreadyDone++; updateUI(); continue;
      }

      const match = matchStudent(name, father);
      if (!match.ok) {
        const reasonText = ({
          'not-in-csv':      '❌ CSV mein nahi → SKIP',
          'father-mismatch': '⚠ Father name MISMATCH → SKIP (galti se bachne ke liye)',
          'ambiguous':       '⚠ Ambiguous match → SKIP',
          'all-used':        '⚠ CSV entry already used → SKIP',
        })[match.reason] || `⚠ ${match.reason} → SKIP`;
        log(`  ${reasonText}`, match.reason === 'father-mismatch' ? 'error' : 'warn');
        if (match.details) log(`     ${match.details}`, 'warn');
        row.style.backgroundColor = match.reason === 'father-mismatch' ? '#f8d7da' : '#fff3cd';

        if (match.reason === 'not-in-csv') state.stats.notFound++;
        else                               state.stats.mismatched++;
        state.failures.push({ name, father, reason: match.reason, details: match.details });
        updateUI(); continue;
      }

      // Match found — process
      log(`  ✓ Match: name + father OK`);
      try {
        await processStudent(row, match.csvRow);
        state.usedCSVRows.add(match.csvRow);
        state.stats.done++;
      } catch (err) {
        log(`  ❌ ${err.message}`, 'error');
        row.style.backgroundColor = '#f8d7da';
        state.stats.failed++;
        state.failures.push({ name, father, reason: err.message });
      }

      updateUI();
      await sleep(CFG.delayBetweenStudents);
    }

    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
    log(`✅ COMPLETE`, 'success');
    log(`   Done now      : ${state.stats.done}`, 'success');
    log(`   Already done  : ${state.stats.alreadyDone}`);
    log(`   Not in CSV    : ${state.stats.notFound}`, state.stats.notFound ? 'warn' : 'info');
    log(`   Mismatch/Skip : ${state.stats.mismatched}`, state.stats.mismatched ? 'warn' : 'info');
    log(`   Failed        : ${state.stats.failed}`, state.stats.failed ? 'error' : 'info');

    if (state.failures.length) {
      log('━━ DETAILS ━━', 'warn');
      state.failures.forEach(f => log(`  • ${f.name || '(?)'} — ${f.reason}${f.details ? ' (' + f.details + ')' : ''}`, 'error'));
    }
    state.isRunning = false;
    updateUI();
  };

  /* ------------------------------- UI ------------------------------------ */
  const createUI = () => {
    const panel = document.createElement('div');
    panel.id = 'udise-filler-panel';
    panel.innerHTML = `
      <style>
        #udise-filler-panel, #udise-filler-panel * {
          box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif;
        }
        #udise-filler-panel {
          position: fixed; top: 90px; right: 16px; width: 420px;
          background: #fff; border: 2px solid #1e40af; border-radius: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.25);
          z-index: 2147483647; font-size: 13px; color: #1f2937;
          max-height: calc(100vh - 110px); display: flex; flex-direction: column;
        }
        .uf-header {
          background: linear-gradient(135deg, #1e40af, #2563eb); color: #fff;
          padding: 10px 14px; border-radius: 8px 8px 0 0;
          display: flex; justify-content: space-between; align-items: center;
          cursor: move; user-select: none;
        }
        .uf-header strong { font-size: 14px; letter-spacing: 0.3px; }
        .uf-ver { font-size: 10px; opacity: 0.7; margin-left: 6px; }
        .uf-min { background: rgba(255,255,255,0.15); border: none; color: #fff;
          width: 26px; height: 26px; border-radius: 4px; cursor: pointer;
          font-size: 16px; font-weight: 700; }
        .uf-min:hover { background: rgba(255,255,255,0.3); }
        .uf-body { padding: 12px; overflow-y: auto; flex: 1; }
        .uf-body.hidden { display: none; }
        .uf-row { margin-bottom: 10px; }
        .uf-label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; color: #374151; }
        .uf-textarea {
          width: 100%; height: 95px; font-family: ui-monospace, monospace;
          font-size: 11px; padding: 6px; border: 1px solid #d1d5db;
          border-radius: 4px; resize: vertical;
        }
        .uf-textarea:focus, .uf-input:focus { outline: none; border-color: #1e40af; }
        .uf-input {
          padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 4px;
          font-size: 12px; width: 60px;
        }
        .uf-config {
          background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 5px;
          padding: 8px; margin-bottom: 10px; display: flex; align-items: center;
          gap: 8px; font-size: 12px;
        }
        .uf-btns { display: flex; flex-wrap: wrap; gap: 6px; }
        .uf-btn {
          padding: 7px 12px; border: none; border-radius: 5px; cursor: pointer;
          font-weight: 600; font-size: 12px; transition: all 0.15s;
        }
        .uf-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
        .uf-btn-primary { background: #1e40af; color: #fff; }
        .uf-btn-success { background: #059669; color: #fff; }
        .uf-btn-info    { background: #0891b2; color: #fff; }
        .uf-btn-warn    { background: #f59e0b; color: #fff; }
        .uf-btn-danger  { background: #dc2626; color: #fff; }
        .uf-btn:disabled { background: #9ca3af !important; cursor: not-allowed; transform: none; }
        .uf-stats {
          display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;
          background: #f3f4f6; padding: 8px; border-radius: 5px; margin: 10px 0;
        }
        .uf-stat { text-align: center; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.4px; }
        .uf-stat-num { font-size: 17px; font-weight: 700; color: #1f2937; display: block; line-height: 1; margin-bottom: 2px; }
        .uf-stat.done .uf-stat-num     { color: #059669; }
        .uf-stat.skipped .uf-stat-num  { color: #6b7280; }
        .uf-stat.failed .uf-stat-num   { color: #dc2626; }
        .uf-stat.notfound .uf-stat-num { color: #f59e0b; }
        .uf-stat.mismatch .uf-stat-num { color: #dc2626; }
        .uf-log {
          background: #111827; color: #e5e7eb; padding: 8px; border-radius: 5px;
          height: 230px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 11px;
          line-height: 1.45;
        }
        .uf-log-line { margin: 1px 0; word-break: break-word; white-space: pre-wrap; }
        .uf-log-error   { color: #fca5a5; }
        .uf-log-success { color: #86efac; }
        .uf-log-warn    { color: #fcd34d; }
        .uf-log-info    { color: #93c5fd; }
        .uf-time { color: #6b7280; font-size: 10px; }
        .uf-hint { font-size: 11px; color: #6b7280; margin-top: 4px; }
      </style>

      <div class="uf-header" id="uf-header">
        <strong>🤖 UDISE+ Auto Filler<span class="uf-ver">v3.0</span></strong>
        <button class="uf-min" id="uf-min" title="Minimize">─</button>
      </div>

      <div class="uf-body" id="uf-body">
        <div class="uf-row">
          <label class="uf-label">📋 CSV Data</label>
          <textarea class="uf-textarea" id="uf-csv" spellcheck="false"
            placeholder="StudentName,FatherName,Attendance,MarksObtained,TotalMarks,Percentage&#10;ADITYA,SATISH YADAV,204,1111,1200,92.58&#10;AKASH,RAJENDRA PRASAD,194,1092,1200,91.00&#10;..."></textarea>
          <div class="uf-hint">Required: <b>StudentName, Attendance, Percentage</b> | Optional: <b>FatherName</b> (verify ke liye)</div>
        </div>

        <div class="uf-config">
          <span><b>Promote → Section:</b></span>
          <input type="text" class="uf-input" id="uf-section" value="A" maxlength="3">
          <span style="color: #6b7280; font-size: 11px;">(jis section mein bhejna hai)</span>
        </div>

        <div class="uf-row uf-btns">
          <button class="uf-btn uf-btn-primary" id="uf-load">📥 Load CSV</button>
          <button class="uf-btn uf-btn-info"    id="uf-check" disabled>🔍 Match Check</button>
          <button class="uf-btn uf-btn-success" id="uf-start" disabled>▶ Start</button>
          <button class="uf-btn uf-btn-warn"    id="uf-pause" disabled>⏸ Pause</button>
          <button class="uf-btn uf-btn-danger"  id="uf-stop"  disabled>⏹ Stop</button>
        </div>

        <div class="uf-stats">
          <div class="uf-stat done">     <span class="uf-stat-num" id="s-done">0</span>Done</div>
          <div class="uf-stat skipped">  <span class="uf-stat-num" id="s-skip">0</span>Already</div>
          <div class="uf-stat failed">   <span class="uf-stat-num" id="s-fail">0</span>Failed</div>
          <div class="uf-stat notfound"> <span class="uf-stat-num" id="s-nf">0</span>Not Found</div>
          <div class="uf-stat mismatch"> <span class="uf-stat-num" id="s-mm">0</span>Mismatch</div>
          <div class="uf-stat">          <span class="uf-stat-num" id="s-total">0</span>On Page</div>
        </div>

        <div class="uf-log" id="uf-log"></div>
      </div>
    `;
    document.body.appendChild(panel);
    makeDraggable(panel.querySelector('#uf-header'), panel);

    const secInput = document.getElementById('uf-section');
    secInput.addEventListener('input', () => {
      CFG.defaults.section = (secInput.value || 'A').trim().toUpperCase();
    });

    document.getElementById('uf-min').onclick = () =>
      document.getElementById('uf-body').classList.toggle('hidden');

    document.getElementById('uf-load').onclick = () => {
      try {
        const txt = document.getElementById('uf-csv').value;
        if (!txt.trim()) throw new Error('CSV khali hai');
        const data = parseCSV(txt);
        state.studentMap.clear();
        data.forEach(r => {
          const n = normalize(r.StudentName);
          if (!n) return;
          if (!state.studentMap.has(n)) state.studentMap.set(n, []);
          state.studentMap.get(n).push(r);
        });
        const total = countCSVEntries();
        let dupes = 0;
        for (const arr of state.studentMap.values()) if (arr.length > 1) dupes += arr.length;
        log(`✓ ${total} students CSV se load hue (${state.studentMap.size} unique names)`, 'success');
        log(`  Father verification: ${state.csvHasFather ? 'ON ✓' : 'OFF — name only'}`, state.csvHasFather ? 'success' : 'warn');
        if (dupes) log(`  ⚠ ${dupes} entries duplicate names mein hai (father se disambiguate honge)`, 'warn');
        document.getElementById('uf-start').disabled = false;
        document.getElementById('uf-check').disabled = false;
      } catch (err) {
        log(`❌ CSV error: ${err.message}`, 'error');
      }
    };

    document.getElementById('uf-check').onclick = () => runMatchCheck();

    document.getElementById('uf-start').onclick = async () => {
      if (state.isRunning) return;
      ['uf-start', 'uf-load', 'uf-check'].forEach(id => document.getElementById(id).disabled = true);
      ['uf-pause', 'uf-stop'].forEach(id => document.getElementById(id).disabled = false);
      try { await runAutomation(); }
      catch (err) { log(`❌ Fatal: ${err.message}`, 'error'); }
      finally {
        ['uf-start', 'uf-load', 'uf-check'].forEach(id => document.getElementById(id).disabled = false);
        ['uf-pause', 'uf-stop'].forEach(id => document.getElementById(id).disabled = true);
        document.getElementById('uf-pause').textContent = '⏸ Pause';
      }
    };

    document.getElementById('uf-pause').onclick = () => {
      state.isPaused = !state.isPaused;
      document.getElementById('uf-pause').textContent = state.isPaused ? '▶ Resume' : '⏸ Pause';
      log(state.isPaused ? '⏸ PAUSED' : '▶ RESUMED', 'warn');
    };

    document.getElementById('uf-stop').onclick = () => {
      if (confirm('Sure stop karna hai? Current student tak complete hoga.')) {
        state.shouldStop = true;
        state.isPaused   = false;
      }
    };
  };

  const makeDraggable = (handle, panel) => {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left  = (e.clientX - dx) + 'px';
      panel.style.top   = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => dragging = false);
  };

  const log = (msg, type = 'info') => {
    const el = document.getElementById('uf-log');
    if (!el) { console.log(`[UDISE] ${msg}`); return; }
    const line = document.createElement('div');
    line.className = `uf-log-line uf-log-${type}`;
    const t = new Date().toLocaleTimeString('en-GB');
    line.innerHTML = `<span class="uf-time">${t}</span> ${escapeHTML(msg)}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    console.log(`[UDISE ${type}]`, msg);
  };

  const escapeHTML = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

  const updateUI = () => {
    document.getElementById('s-done').textContent  = state.stats.done;
    document.getElementById('s-skip').textContent  = state.stats.alreadyDone;
    document.getElementById('s-fail').textContent  = state.stats.failed;
    document.getElementById('s-nf').textContent    = state.stats.notFound;
    document.getElementById('s-mm').textContent    = state.stats.mismatched;
    document.getElementById('s-total').textContent = state.stats.total;
  };

  /* -------------------------------- INIT --------------------------------- */
  createUI();
  log('✓ Tool ready (v3.0 — Father Verification)', 'success');
  log('  Workflow: CSV paste → Load CSV → Match Check → Start', 'info');
  log('  FatherName column add karo to galti se bachne ke liye', 'info');

})();
