/*
 * instructor/store.js — Alpine `inst` store for the instructor page.
 *
 * Full rewrite of classes.js / roster.js / assignments.js / tabs.js / tutoring.js /
 * panels.js onto reactive state. Lists (classes, assignment files, tutoring threads,
 * links, audit tables) render via <template x-for>; tabs / modals / inline editors are
 * reactive; the imperative carve-outs (cookies, split-resize, fit-scroll, inline-rename,
 * panel collapse) stay in core.js and are called from here / the template.
 *
 * Every backend endpoint, payload and method is preserved byte-for-byte.
 */
document.addEventListener('alpine:init', () => {
  const esc = (s) => escapeHtml(s);
  const fmtAgo = (iso) => {
    const d = parseServerTime(iso);
    if (!d) return '';
    const ms = Date.now() - d.getTime();
    if (ms < 60000) return 'just now';
    const m = Math.round(ms/60000); if (m < 60) return m + 'm ago';
    const h = Math.round(ms/3600000); if (h < 24) return h + 'h ago';
    const day = Math.round(ms/86400000); if (day < 30) return day + 'd ago';
    return fmtDate(iso);
  };
  const tutFmtTime = (iso) => fmtDateTime(iso);
  const fileExt = (name) => { const i = (name||'').lastIndexOf('.'); return i > 0 ? name.slice(i+1).toLowerCase() : ''; };

  Alpine.store('inst', {
    // ── TA capability gating ──────────────────────────────────────────────────
    // window.LT_PANEL is injected by the template: {mode:'instructor'} on the
    // normal /instructor page, or {mode:'ta', ta_id, ta_name, assignment_management,
    // class_id, class_name} when served from /ta/<uuid>. UI gating only — every
    // permission is enforced again server-side.
    get panel() { return window.LT_PANEL || { mode: 'instructor' }; },
    get isTA() { return this.panel.mode === 'ta'; },
    get canManageAssignments() { return !this.isTA || !!this.panel.assignment_management; },
    ownsThread(t) { return !this.isTA || !!(t && t.ta_id && t.ta_id === this.panel.ta_id); },
    get canEditTutThread() { return this.ownsThread(this.tutThread); },

    // ── classes / layout ──────────────────────────────────────────────────────
    classes: [], currentClassId: null, currentClassName: '',
    sidebarExpandedClass: null,
    sidebarAsn: {},                     // classId -> { loading, items: [] }
    classCreateOpen: false, newClass: { name: '', term: '' },

    // ── assignments / files ────────────────────────────────────────────────────
    assignments: [], currentAsnId: null, activeTitleSet: [],
    asnTab: 'files', rosterTab: 'roster',
    remarks: '', remarksStatus: '',
    files: [], filesError: '',
    uploadPending: [], uploadStatus: '', hintStatus: '',
    failedTasks: [],
    activeSummaryFileIds: [],
    pendingRestoreAsnId: null,

    // ── roster ──────────────────────────────────────────────────────────────────
    rosterHtml: '', rosterUploadMsg: '', newStudent: { first: '', last: '', email: '' }, rosterDragover: false,

    // ── student reset-link modal ────────────────────────────────────────────────
    srlOpen: false, srlEnrollId: null, srlName: '', srlLink: '', srlSub: '', srlHint: '', srlStatus: '',

    // ── teaching assistants (right-panel "Assistant" tab; instructor mode only) ──
    assistants: [], asstState: 'loading', asstForm: { name: '', email: '' }, asstStatus: '',
    asstModal: null, asstModalStatus: '', asstConfirmOpen: false,
    asstTip: { show: false, text: '', x: 0, y: 0 },

    // ── instructor audit (whole-class, roster→audit tab) ──────────────────────────
    instAuditSelectedAsnId: null, instAuditSessions: [], instAuditState: 'empty',

    // ── assignment audit (asn→audit tab) ──────────────────────────────────────────
    asnAuditSessions: [], asnAuditState: 'empty',

    // ── audit session-list sorting (shared by both audit tables) ──────────────────
    // started_at is "%Y-%m-%d %H:%M" → lexicographic order == chronological order.
    auditSort: { key: 'started_at', dir: 'desc' },

    // ── audit conversation modal ──────────────────────────────────────────────────
    auditOpen: false, auditTitle: '', auditSub: '', auditFiles: [], auditMessages: [], auditState: 'loading',
    auditSessionId: null, auditClosed: false, auditCanClose: false, auditClosing: false,

    // ── file-detail modal ─────────────────────────────────────────────────────────
    fdOpen: false, fd: null, fdState: 'loading', fdError: '', fdSaveStatus: '', fdRisk: null, fdBusy: false,
    fdTagsStatus: '',

    // ── compile & run modal ─────────────────────────────────────────────────────────
    compileOpen: false, compileFileId: null, compileTitle: '', compileSub: '',
    compileState: 'loading', compileError: '',
    compileMeta: {}, compileAnalysis: null, compileRun: null,
    compileLastSuccess: null,                 // { run, at, stale }
    compileStdin: '', compileBusy: { analyze: false, run: false }, compileRunStatus: { text: '', color: '' },

    // (The project-compile module moved to the full-page workbench at
    //  /instructor/compile_workbench — see pages/instructor/workbench.js.)
    _summaryPollTimer: null,

    // ── tutoring ──────────────────────────────────────────────────────────────────────
    tutThreads: [], tutThreadState: 'loading',
    tutLinks: [], tutLinkState: 'loading',
    tutThreadId: null, tutThreadAsnId: null, tutThread: null,
    tutView: 'list', tutMessages: [], tutFiles: [], tutThreadTitle: '', tutMsgState: 'loading',
    tutNewChatOpen: false, tutNewChatName: '',
    tutNewLinkOpen: false, tutNewLink: { alias: '', pwEnabled: false, pw: '' }, tutNewLinkStatus: '',
    tutQuestion: '', tutComposerStatus: '', tutSending: false,
    tutRenameEditing: false, tutRenameValue: '',
    tutPasteOpen: false, tutPaste: { name: '', content: '' }, tutPasteStatus: '',
    tutFileOpen: false, tutFile: null, tutFileStdin: '', tutFileStatus: '', tutFileResultHtml: '', tutFileContent: '',

    // ── getters ──────────────────────────────────────────────────────────────────────
    get currentAsn() { return (this.assignments || []).find(a => a.id === this.currentAsnId) || null; },
    get sortedClasses() {
      return [...this.classes].sort((a, b) => {
        const aa = a.is_active !== false, ba = b.is_active !== false;
        if (aa && !ba) return -1; if (!aa && ba) return 1; return 0;
      });
    },
    classInitials(c) { return (c.name || 'CL').split(/\s+/).map(s => s[0] || '').join('').slice(0, 3).toUpperCase(); },
    activeTitleHas(t) { return this.activeTitleSet.includes(t); },
    // Files grouped for display: optional remarks row, then Source/Other sections.
    get displayFiles() {
      const out = [];
      const asn = this.currentAsn;
      if (asn && asn.description) out.push({ kind: 'remarks', active: asn.remarks_active !== false });
      const sorted = (this.files || []).slice().sort((a, b) => {
        const ea = fileExt(a.name), eb = fileExt(b.name);
        if (ea !== eb) return ea < eb ? -1 : 1;
        if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      });
      const active = sorted.filter(f => f.active !== false), excluded = sorted.filter(f => f.active === false);
      const src = active.filter(f => f.is_source), other = active.filter(f => !f.is_source);
      const both = src.length > 0 && other.length > 0;
      if (src.length)   { out.push({ kind: 'header', label: both ? 'Source Code Files' : '' }); src.forEach(f => out.push({ kind: 'file', f })); }
      if (other.length) { out.push({ kind: 'header', label: both ? 'Other Files' : '' }); other.forEach(f => out.push({ kind: 'file', f })); }
      if (excluded.length) { out.push({ kind: 'header', label: 'Excluded Files' }); excluded.forEach(f => out.push({ kind: 'file', f })); }
      if (!this.files.length && !(asn && asn.description)) out.push({ kind: 'empty' });
      return out;
    },

    // ── bootstrap ─────────────────────────────────────────────────────────────────────
    init() {
      // TA mode: no roster tab (default to audit) and exactly one course — select it.
      if (this.isTA) this.rosterTab = 'audit';
      this.loadClasses().then(() => {
        this.restoreLastAccessed();
        if (this.isTA && !this.currentClassId && this.classes.length) {
          this.selectClass(this.classes[0].id, this.classes[0].name);
        }
      });
    },

    // ── classes ──────────────────────────────────────────────────────────────────────
    async loadClasses() {
      try {
        const items = await fetch('/api/classes').then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); });
        this.classes = items || [];
      } catch (e) { console.error('Load classes failed:', e); }
    },

    toggleClassCreate() { this.classCreateOpen = !this.classCreateOpen; if (this.classCreateOpen) Alpine.nextTick(() => $id('clsName')?.focus()); fitRosterScroll(); },

    async createClass() {
      const name = (this.newClass.name || '').trim();
      const term = (this.newClass.term || '').trim();
      if (!name) { alert('Enter a class name'); return; }
      try {
        const r = await fetch('/api/classes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, term }) });
        if (!r.ok) throw new Error('Create failed: ' + r.status);
        await r.json();
        this.newClass = { name: '', term: '' };
        this.classCreateOpen = false;
        await this.loadClasses();
        fitRosterScroll();
      } catch (e) { console.error(e); alert('Could not create class. Ensure POST /api/classes exists.'); }
    },

    renameClass(c, newName) {
      c.name = newName;
      if (this.currentClassId === c.id) this.currentClassName = newName;
      showNotification('Class renamed.');
      fetch(`/api/classes/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName, term: c.term }) })
        .catch(() => console.warn('PATCH /api/classes/:id not available; keeping local rename.'));
    },
    renameClassTerm(c, newTerm) {
      c.term = newTerm;
      showNotification('Term updated.');
      fetch(`/api/classes/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: c.name, term: newTerm }) })
        .catch(() => console.warn('PATCH /api/classes/:id not available; keeping local term update.'));
    },
    async deleteClass(c) {
      if (this.isTA) return;
      if (!confirm(`Delete course "${c.name || 'Untitled Class'}"?\n\nThis permanently removes the course, its assignments, files, roster and tutoring chats. This cannot be undone.`)) return;
      try {
        const res = await fetch(`/api/classes/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `Delete failed (${res.status})`);
        if (this.currentClassId === c.id) {
          this.currentClassId = null; this.currentClassName = ''; this.currentAsnId = null;
          this.assignments = []; this.files = []; this.rosterHtml = '';
        }
        delete this.sidebarAsn[c.id];
        if (this.sidebarExpandedClass === c.id) this.sidebarExpandedClass = null;
        showNotification('Course deleted.');
        if (document.documentElement.classList.contains('course-mode')) { location.href = '/courses'; return; }
        await this.loadClasses();
      } catch (e) { showNotification(e.message || 'Could not delete course.', true); }
    },
    async deleteSidebarAsn(classId, a) {
      if (!this.canManageAssignments) return;
      if (!confirm(`Delete assignment "${a.title}"?\n\nThis permanently removes its files, tutoring chats and links. This cannot be undone.`)) return;
      try {
        const res = await fetch(`/api/instructor/assignments/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `Delete failed (${res.status})`);
        if (this.currentAsnId === a.id) { this.currentAsnId = null; this.files = []; this.remarks = ''; }
        this.activeTitleSet = this.activeTitleSet.filter(t => t !== a.title);
        showNotification('Assignment deleted.');
        if (classId === this.currentClassId) await this.loadAssignments(classId);
        await this.loadSidebarAsn(classId);
      } catch (e) { showNotification(e.message || 'Could not delete assignment.', true); }
    },
    toggleClassActive(c) {
      fetch(`/api/classes/${c.id}/toggle_active`, { method: 'POST' }).then(r => r.json()).then(data => {
        if (data.ok) { c.is_active = data.is_active; showNotification(data.is_active ? 'Course activated.' : 'Course deactivated.'); }
      }).catch(() => showNotification('Failed to update course status.', true));
    },

    // sidebar assignment dropdown
    toggleClassAsnDropdown(classId) {
      const wasOpen = this.sidebarExpandedClass === classId;
      this.sidebarExpandedClass = wasOpen ? null : classId;
      if (!wasOpen) this.loadSidebarAsn(classId);
    },
    async loadSidebarAsn(classId) {
      this.sidebarAsn[classId] = { loading: true, items: [], newTitle: '' };
      try {
        const items = await fetch(`/api/instructor/assignments?class_id=${encodeURIComponent(classId)}`).then(r => r.json()) || [];
        this.sidebarAsn[classId] = { loading: false, items, newTitle: '', error: false };
      } catch (e) {
        this.sidebarAsn[classId] = { loading: false, items: [], newTitle: '', error: true };
      }
    },
    refreshSidebarAsn(classId) { if (this.sidebarExpandedClass === classId) this.loadSidebarAsn(classId); },

    renameSidebarAsn(classId, a, newTitle) {
      a.title = newTitle;
      this.renameAssignmentLocally(a.id, newTitle);
      showNotification('Assignment renamed.');
      fetch(`/api/instructor/assignments/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle }) })
        .catch(() => console.warn('PATCH /api/instructor/assignments/:id not available; keeping local rename.'))
        .finally(() => { if (classId === this.currentClassId) this.loadAssignments(classId); });
    },
    async setSidebarAsnDue(classId, a, dueDate, dueTime) {
      const prev = { d: a.due_date, t: a.due_time };
      a.due_date = dueDate || null;
      a.due_time = dueDate ? (dueTime || null) : null;
      try {
        const res = await fetch(`/api/instructor/assignments/${encodeURIComponent(a.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ due_date: a.due_date, due_time: a.due_time }) });
        if (!res.ok) throw new Error('save failed');
        showNotification(a.due_date ? 'Due date saved.' : 'Due date cleared.');
      } catch (e) {
        a.due_date = prev.d; a.due_time = prev.t;
        showNotification('Could not save due date.', true);
      }
    },
    async toggleSidebarAsnActive(classId, a, makeActive) {
      try {
        const res = await fetch('/api/instructor/assignments/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignment_id: a.id, active: makeActive }) }).then(r => r.json());
        if (res.ok) {
          a.active = makeActive;
          if (makeActive) { if (!this.activeTitleSet.includes(a.title)) this.activeTitleSet.push(a.title); }
          else this.activeTitleSet = this.activeTitleSet.filter(t => t !== a.title);
          showNotification((makeActive ? 'Activated' : 'Deactivated') + ': ' + a.title);
        } else { a.active = !makeActive; showNotification(res.error || 'Could not update.', true); }
      } catch (e) { a.active = !makeActive; showNotification('Network error.', true); }
    },
    async createSidebarAsn(classId) {
      const slot = this.sidebarAsn[classId]; if (!slot) return;
      const title = (slot.newTitle || '').trim();
      if (!title) return;
      try {
        const res = await fetch('/api/instructor/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ class_id: classId, title }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Failed');
        slot.newTitle = '';
        showNotification('Assignment created.');
        if (classId === this.currentClassId) await this.loadAssignments(classId);
        await this.loadSidebarAsn(classId);
      } catch (e) { showNotification(e.message || 'Could not create assignment.', true); }
    },

    renameAssignmentLocally(assignmentId, newTitle) {
      const t = (newTitle || '').trim(); if (!t) return;
      this.assignments = (this.assignments || []).map(a => a.id !== assignmentId ? a : { ...a, title: t });
    },

    // ── select class / assignment ───────────────────────────────────────────────────────
    selectClass(id, name) {
      this.currentClassId = id;
      this.currentClassName = name || id;
      if (this.sidebarExpandedClass !== id) this.toggleClassAsnDropdown(id);
      if (!this.isTA) this.loadRoster();
      if (!this.isTA && this.rosterTab === 'assistant') this.loadAssistants();
      this.instAuditSelectedAsnId = null;
      this.currentAsnId = null;
      this.uploadPending = []; this.uploadStatus = '';
      this.assignments = [];
      this.loadAssignments(id);
      fitRosterScroll();
      fetch('/api/active_class', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ class_id: id }) }).catch(() => {});
    },

    async loadAssignments(classId) {
      const cls = typeof classId === 'string' ? classId : (this.currentClassId || '');
      const url = cls ? `/api/instructor/assignments?class_id=${encodeURIComponent(cls)}` : '/api/instructor/assignments';
      try { this.assignments = await fetch(url).then(r => r.json()) || []; }
      catch (e) { console.error('[loadAssignments]', e); this.assignments = []; }
      try {
        const actives = await fetch('/api/student/active_assignments').then(r => r.json());
        const rows = Array.isArray(actives) ? actives : ((actives && Array.isArray(actives.assignments)) ? actives.assignments : []);
        this.activeTitleSet = [...new Set(rows.map(a => a && a.title).filter(Boolean))];
      }
      catch (e) { console.error('[active_assignments]', e); }
      const refreshCls = (typeof cls === 'string' && cls) ? cls : this.currentClassId;
      if (refreshCls) this.refreshSidebarAsn(refreshCls);
      if (this.asnTab === 'audit') this.renderInstAuditPanel();
      if (this.pendingRestoreAsnId) {
        const target = this.pendingRestoreAsnId; this.pendingRestoreAsnId = null;
        if ((this.assignments || []).some(a => a.id === target)) this.selectAssignment(target);
      }
    },

    selectAssignment(asnId) {
      this.currentAsnId = asnId;
      this.rememberLastAssignment(this.currentClassId, asnId);
      const asn = this.currentAsn;
      this.remarks = asn?.description || '';
      this.remarksStatus = '';
      this.resetUploadZone();
      this.refreshAssignmentFiles();
      this.loadAssignmentTasks(asnId);
      Alpine.nextTick(fitFilesListScroll);
      if (this.asnTab === 'audit') this.renderAsnAuditPanel();
      if (this.asnTab === 'tutoring') this.renderAsnTutoringPanel();
    },
    openAssignmentInstructor(asnId) { this.selectAssignment(asnId); Alpine.nextTick(() => $id('asnFilesCard')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })); },

    // ── last-accessed cookie ────────────────────────────────────────────────────────────
    rememberLastAssignment(classId, asnId) { if (!classId || !asnId) return; try { setCookie(LAST_ASN_COOKIE, JSON.stringify({ classId, asnId }), 365); } catch {} },
    restoreLastAccessed() {
      let saved = null; try { saved = JSON.parse(getCookie(LAST_ASN_COOKIE) || 'null'); } catch {}
      if (!saved || !saved.classId || !saved.asnId) return;
      const cls = (this.classes || []).find(c => c.id === saved.classId);
      if (!cls) return;
      this.pendingRestoreAsnId = saved.asnId;
      this.selectClass(cls.id, cls.name);
    },

    // ── tabs ───────────────────────────────────────────────────────────────────────────
    switchAsnTab(tab) {
      this.asnTab = tab;
      if (tab === 'audit') this.renderAsnAuditPanel();
      else if (tab === 'tutoring') this.renderAsnTutoringPanel();
      else Alpine.nextTick(fitFilesListScroll);
    },
    switchRosterTab(tab) { this.rosterTab = tab; if (tab === 'audit') this.renderInstAuditPanel(); else if (tab === 'assistant') this.loadAssistants(); },

    // ── roster ───────────────────────────────────────────────────────────────────────────
    async loadRoster() {
      if (!this.currentClassId) { this.rosterHtml = '<div class="muted">No students yet.</div>'; Alpine.nextTick(fitRosterScroll); return; }
      try { this.rosterHtml = await fetch(`/partials/roster/${this.currentClassId}`).then(r => r.text()); Alpine.nextTick(fitRosterScroll); }
      catch (e) { console.error(e); this.rosterHtml = '<div class="muted">Could not load roster.</div>'; }
    },
    addStudent() {
      if (!this.currentClassId) { alert('Select a class first'); return; }
      const { first, last, email } = { first: this.newStudent.first.trim(), last: this.newStudent.last.trim(), email: this.newStudent.email.trim() };
      if (!first || !last || !email) { alert('Fill all fields'); return; }
      if (!isValidEmail(email)) { alert('Please enter a valid email'); $id('stEmail')?.focus(); return; }
      fetch(`/api/classes/${this.currentClassId}/students`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: first, last_name: last, email }) })
        .then(async r => { if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); } return r.json(); })
        .then(() => { this.newStudent = { first: '', last: '', email: '' }; this.loadRoster(); })
        .catch(err => alert(err.message || 'Could not add student'));
    },
    // toggleStudent is invoked from the server-rendered roster partial via a global shim.
    toggleStudent(studentId) {
      if (!this.currentClassId || !studentId) return;
      fetch(`/api/classes/${this.currentClassId}/students/${encodeURIComponent(studentId)}/active`, { method: 'PATCH' }).then(() => this.loadRoster()).catch(() => {});
    },
    // Student password reset link (single-use, server-tracked — same machinery as the
    // super-admin console). Invoked from the server-rendered roster partial via a shim.
    async openStudentResetLink(enrollId, name) {
      if (!this.currentClassId || !enrollId) return;
      this.srlEnrollId = enrollId; this.srlName = name || '';
      await this.fetchStudentResetLink(false);
    },
    async fetchStudentResetLink(forceNew) {
      if (!this.currentClassId || !this.srlEnrollId) return;
      try {
        const res = await fetch(`/api/classes/${this.currentClassId}/students/${encodeURIComponent(this.srlEnrollId)}/reset_link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force_new: !!forceNew }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) { alert(data.error || 'Could not generate reset link'); return; }
        this.srlLink = data.link;
        this.srlSub  = (this.srlName ? this.srlName + (data.username ? ` (${data.username})` : '') + ' — ' : '')
                       + 'single-use link, valid until ' + fmtDateTime(data.expires_at);
        this.srlHint = data.reused
          ? 'This is the current active link (not used yet). It stops working as soon as the password is set once.'
          : 'A new link was generated — any previous link is now invalid. It stops working as soon as the password is set once.';
        this.srlStatus = forceNew ? 'New link generated — previous link invalidated.' : '';
        this.srlOpen = true;
      } catch { alert('Network error'); }
    },
    closeStudentResetLink() { this.srlOpen = false; this.srlEnrollId = null; this.srlLink = ''; this.srlStatus = ''; },
    async copyStudentResetLink() {
      if (!this.srlLink) return;
      try { await navigator.clipboard.writeText(this.srlLink); }
      catch {
        const inp = document.getElementById('srlLinkInput');
        if (inp) { inp.select(); document.execCommand('copy'); }
      }
      this.srlStatus = 'Link copied to clipboard.';
    },

    // ── teaching assistants (Assistant tab) ─────────────────────────────────────────
    async loadAssistants() {
      if (this.isTA) return;                        // a TA never manages TA accounts
      if (!this.currentClassId) { this.assistants = []; this.asstState = 'ready'; return; }
      this.asstState = 'loading';
      try {
        const data = await fetch(`/api/instructor/assistants?class_id=${encodeURIComponent(this.currentClassId)}`).then(r => r.json());
        if (data.error) throw new Error(data.error);
        this.assistants = data.assistants || [];
        this.asstState = 'ready';
      } catch (e) { this.assistants = []; this.asstState = 'ready'; this.asstStatus = e.message || 'Could not load assistants.'; }
    },
    async createAssistant() {
      if (!this.currentClassId) { this.asstStatus = 'Select a class first.'; return; }
      const name = (this.asstForm.name || '').trim();
      if (!name) { this.asstStatus = 'Name is required.'; $id('asstName')?.focus(); return; }
      const email = (this.asstForm.email || '').trim();
      if (email && !isValidEmail(email)) { this.asstStatus = 'Please enter a valid email.'; $id('asstEmail')?.focus(); return; }
      try {
        const res = await fetch('/api/instructor/assistants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ class_id: this.currentClassId, name, email }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Could not add assistant');
        this.asstForm = { name: '', email: '' }; this.asstStatus = '';
        await this.loadAssistants();
        const created = (this.assistants || []).find(t => t.id === data.assistant.id);
        if (created) this.openAsstManage(created);  // hand the instructor the link right away
      } catch (e) { this.asstStatus = e.message || 'Network error.'; }
    },
    openAsstManage(ta) { this.asstModal = ta; this.asstModalStatus = ''; this.asstConfirmOpen = false; },
    closeAsstManage() { this.asstModal = null; this.asstConfirmOpen = false; },
    async patchAssistant(ta, patch) {
      try {
        const res = await fetch(`/api/instructor/assistants/${encodeURIComponent(ta.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Update failed');
        Object.assign(ta, data.assistant);
        this.asstModalStatus = 'Saved.';
      } catch (e) { this.asstModalStatus = e.message || 'Network error.'; this.loadAssistants(); }
    },
    async regenerateAssistant(ta) {
      try {
        const res = await fetch(`/api/instructor/assistants/${encodeURIComponent(ta.id)}/regenerate`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Regenerate failed');
        Object.assign(ta, data.assistant);
        this.asstModalStatus = 'New link generated — the previous link is now invalid.';
      } catch (e) { this.asstModalStatus = e.message || 'Network error.'; }
    },
    async removeAssistant() {
      const ta = this.asstModal;
      if (!ta) return;
      try {
        const res = await fetch(`/api/instructor/assistants/${encodeURIComponent(ta.id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Delete failed');
        this.closeAsstManage();
        showNotification('Teaching assistant removed.');
        await this.loadAssistants();
      } catch (e) { this.asstModalStatus = e.message || 'Network error.'; this.asstConfirmOpen = false; }
    },
    // Floating tooltip for truncated name/email cells (in-page, never a native popup).
    asstTipShow(e, text) {
      const el = e.target;
      if (!text || el.scrollWidth <= el.clientWidth) return;   // only when actually truncated
      const r = el.getBoundingClientRect();
      this.asstTip = { show: true, text, x: Math.max(8, r.left), y: r.bottom + 4 };
    },
    asstTipHide() { this.asstTip.show = false; },
    onRosterFilePicked(e) { const f = e.target.files?.[0]; if (!f) return; if (!this.currentClassId) { alert('Select a class first'); e.target.value = ''; return; } this.uploadRoster(f); e.target.value = ''; },
    onRosterDrop(e) { this.rosterDragover = false; if (!this.currentClassId) { alert('Select a class first'); return; } const f = e.dataTransfer?.files?.[0]; if (f) this.uploadRoster(f); },
    async uploadRoster(file) {
      const say = (m) => { this.rosterUploadMsg = m || ''; };
      try {
        say('Uploading…');
        const tryUpload = async (url, fd) => {
          const res = await fetch(url, { method: 'POST', body: fd });
          const ctype = res.headers.get('content-type') || '';
          if (!ctype.includes('application/json')) { const txt = await res.text(); return { ok: false, __status: res.status, error: `Non-JSON ${res.status}. ${txt.slice(0, 200)}` }; }
          const data = await res.json(); data.__status = res.status; return data;
        };
        const fd1 = new FormData(); fd1.append('file', file);
        let data = await tryUpload(`/api/classes/${this.currentClassId}/students/upload`, fd1);
        if (data.__status === 404) { const fd2 = new FormData(); fd2.append('file', file); fd2.append('project_id', this.currentClassId); data = await tryUpload('/instructor/roster/upload', fd2); }
        if (!data.ok) { say(data.error || `Upload failed (${data.__status || '?'})`); console.error('[Roster upload error]', data); return; }
        const parts = [];
        if ('added' in data) parts.push(`Added ${data.added}`);
        if ('updated' in data) parts.push(`Updated ${data.updated}`);
        if ('skipped' in data) parts.push(`Skipped ${data.skipped}`);
        say(parts.length ? parts.join(' • ') : 'Upload complete');
        this.loadRoster();
      } catch (err) { console.error(err); say('Upload failed'); }
    },

    // ── assignment files ────────────────────────────────────────────────────────────────────
    async refreshAssignmentFiles() {
      if (!this.currentAsnId) { this.files = []; return; }
      try {
        const files = await fetch(`/api/instructor/assignment_files?assignment_id=${encodeURIComponent(this.currentAsnId)}`).then(r => r.json());
        this.files = Array.isArray(files) ? files : [];
        this.filesError = '';
      } catch (e) { console.error(e); this.files = []; this.filesError = 'Could not load files.'; }
      Alpine.nextTick(fitFilesListScroll);
    },
    fileRowTitle(f) {
      const active = f.active !== false, verb = f.editable ? 'view / edit' : 'view summary';
      return active ? `Click to ${verb}` : `Excluded from AI context — click to ${verb}`;
    },
    downloadFile(fileId, name) {
      if (!fileId) return;
      const a = document.createElement('a');
      a.href = `/api/instructor/file_download?file_id=${encodeURIComponent(fileId)}`;
      if (name) a.download = name;
      a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    },
    async toggleStar(f, starred = !f.starred) {
      const prev = !!f.starred;
      try {
        const res = await fetch('/api/instructor/star_file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: f.id, starred }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Star failed');
        f.starred = starred;
        if (this.fd && this.fd.id === f.id) this.fd.starred = starred;
        this.refreshAssignmentFiles();
      } catch (e) { f.starred = prev; if (this.fd && this.fd.id === f.id) this.fd.starred = prev; showNotification(e.message || 'Could not update star.', true); }
    },
    async toggleFile(f, active) {
      try {
        const res = await fetch('/api/instructor/toggle_file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: f.id, active }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Toggle failed');
        f.active = active;
        if (this.fd && this.fd.id === f.id) this.fd.active = active;
        this.refreshAssignmentFiles();
      } catch (e) { showNotification(e.message || 'Could not update file.', true); f.active = !active; }
    },
    async toggleRemarks(active) {
      const asnId = this.currentAsnId;
      try {
        const res = await fetch('/api/instructor/toggle_remarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignment_id: asnId, active }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Toggle failed');
        const asn = this.currentAsn; if (asn) asn.remarks_active = active;
      } catch (e) { showNotification(e.message || 'Could not update remarks.', true); }
    },

    // upload zone
    resetUploadZone() { this.uploadPending = []; this.uploadStatus = ''; const i = $id('asnFileInput'); if (i) i.value = ''; },
    onAsnFilePicked(e) { this.addAsnFiles(e.target.files); e.target.value = ''; },
    onAsnDrop(e) { this.addAsnFiles(e.dataTransfer.files); },
    addAsnFiles(fileList) {
      const existing = new Set(this.uploadPending.map(f => f.name));
      Array.from(fileList || []).forEach(f => {
        if (existing.has(f.name)) return;
        existing.add(f.name);
        this.uploadPending.push(f);
      });
      this.uploadStatus = '';
    },
    removeAsnPending(i) { this.uploadPending.splice(i, 1); },
    asnFileSize(f) { return (f.size / 1024).toFixed(1) + ' KB'; },
    async saveRemarks() {
      if (!this.currentAsnId) { showNotification('Select an assignment first.', true); return; }
      const remarks = (this.remarks || '').trim();
      this.remarksStatus = 'Saving…';
      try {
        const res = await fetch('/api/instructor/assignment_remarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignment_id: this.currentAsnId, remarks }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Save failed');
        const asn = this.currentAsn; if (asn) asn.description = remarks;
        showNotification('Remarks saved.');
        this.remarksStatus = 'Saved';
        setTimeout(() => { this.remarksStatus = ''; }, 2000);
        this.refreshAssignmentFiles();
      } catch (e) { this.remarksStatus = e.message || 'Save failed.'; showNotification(e.message || 'Save failed.', true); }
    },
    async doAsnUpload() {
      if (!this.uploadPending.length) return;
      if (!this.currentAsnId) { showNotification('Select an assignment first.', true); return; }
      this.uploadStatus = 'Uploading…';
      const fd = new FormData();
      fd.append('assignment_id', this.currentAsnId);
      const remarks = (this.remarks || '').trim();
      if (remarks) fd.append('remarks', remarks);
      this.uploadPending.forEach(f => fd.append('file', f));
      try {
        const res = await fetch('/api/instructor/assignment_upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Upload failed');
        const n = data.uploaded?.length || 0;
        showNotification(`Uploaded ${n} file${n !== 1 ? 's' : ''}.`);
        if (remarks) { const asn = this.currentAsn; if (asn) asn.description = remarks; }
        const uploadedIds = (data.uploaded || []).map(u => u.id).filter(Boolean);
        uploadedIds.forEach(id => { if (!this.activeSummaryFileIds.includes(id)) this.activeSummaryFileIds.push(id); });
        this.resetUploadZone();
        this.uploadStatus = '';
        this.refreshAssignmentFiles();
        if (uploadedIds.length) this.pollForSummaries(this.currentAsnId, uploadedIds.slice());
      } catch (e) { this.uploadStatus = e.message || 'Upload failed.'; showNotification(e.message || 'Upload failed.', true); }
    },

    // summary polling
    pollForSummaries(asnId, pendingIds, attemptsLeft = 12) {
      if (this._summaryPollTimer) { clearTimeout(this._summaryPollTimer); this._summaryPollTimer = null; }
      if (!asnId || asnId !== this.currentAsnId || !pendingIds.length) return;
      this._summaryPollTimer = setTimeout(() => {
        fetch(`/api/instructor/assignment_files?assignment_id=${encodeURIComponent(asnId)}`).then(r => r.json()).then(files => {
          if (asnId !== this.currentAsnId) return;
          const byId = new Map((files || []).map(f => [f.id, f]));
          const stillPending = pendingIds.filter(id => { const f = byId.get(id); return f && !f.summary; });
          const becameReady = stillPending.length < pendingIds.length;
          if (attemptsLeft <= 1 && stillPending.length) { this.activeSummaryFileIds = this.activeSummaryFileIds.filter(id => !stillPending.includes(id)); this.refreshAssignmentFiles(); return; }
          if (becameReady) { const done = pendingIds.filter(id => !stillPending.includes(id)); this.activeSummaryFileIds = this.activeSummaryFileIds.filter(id => !done.includes(id)); this.refreshAssignmentFiles(); }
          if (stillPending.length) this.pollForSummaries(asnId, stillPending, attemptsLeft - 1);
        }).catch(() => {});
      }, 2000);
    },
    async regenerateSummary(fileId) {
      if (!fileId) return;
      if (!this.activeSummaryFileIds.includes(fileId)) this.activeSummaryFileIds.push(fileId);
      try {
        const res = await fetch('/api/instructor/generate_file_summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Generation failed');
        this.activeSummaryFileIds = this.activeSummaryFileIds.filter(id => id !== fileId);
        if (this.fd && this.fd.id === fileId) this.fd.summary = data.summary || '';
        showNotification('Summary generated.');
      } catch (e) { this.activeSummaryFileIds = this.activeSummaryFileIds.filter(id => id !== fileId); showNotification(e.message || 'Summary generation failed.', true); }
    },

    // failed LLM tasks (instructor-only endpoint — the TA panel hides this section)
    async loadAssignmentTasks(asnId) {
      if (!asnId || this.isTA) { this.failedTasks = []; return; }
      try { const data = await fetch(`/api/instructor/llm_tasks?assignment_id=${encodeURIComponent(asnId)}`).then(r => r.json()); if (asnId !== this.currentAsnId) return; this.failedTasks = data.tasks || []; }
      catch { this.failedTasks = []; }
    },
    async retryAssignmentTask(t) {
      t._retrying = true;
      try { const res = await fetch(`/api/instructor/llm_tasks/${t.id}/retry`, { method: 'POST' }); const data = await res.json(); if (!data.ok && data.error) alert('Retry failed: ' + data.error); }
      catch { alert('Network error during retry.'); }
      t._retrying = false;
      this.loadAssignmentTasks(this.currentAsnId);
      this.refreshAssignmentFiles();
    },
    taskErr(t) { return t.error ? (t.error.length > 140 ? t.error.slice(0, 140) + '…' : t.error) : ''; },

    // ── file-detail modal ────────────────────────────────────────────────────────────────────
    openFileDetail(fileId) {
      this.fd = null; this.fdState = 'loading'; this.fdError = ''; this.fdSaveStatus = ''; this.fdRisk = null;
      this.fdOpen = true;
      this._fdFileId = fileId;
      fetch(`/api/instructor/file_detail?file_id=${encodeURIComponent(fileId)}`).then(r => r.json()).then(f => {
        if (f.error) throw new Error(f.error);
        if (this._fdFileId !== fileId) return;
        f._savedContent = f.content;
        this.fd = f; this.fdState = 'ready';
      }).catch(e => { this.fdState = 'error'; this.fdError = e.message || 'Could not load file.'; });
    },
    closeFileDetail() { this.fdOpen = false; this._fdFileId = null; },
    fdEditorHint() { return this.fd && this.fd.is_source ? '— edits are screened for risky code before saving' : ''; },
    fdCompileStatusText() {
      const f = this.fd; if (!f || !(f.is_source && f.has_main)) return null;
      const rr = f.last_run;
      if (!rr) return { text: 'Not compiled yet — use Compile & Run.', color: '' };
      let s, color;
      if (rr.security_rejected) { s = '⛔ Last run: blocked (security)'; color = '#b91c1c'; }
      else if (rr.ok) { s = '✓ Last run: success (exit 0)'; color = '#166534'; }
      else { s = '✗ Last run: failed (exit ' + (rr.exit_code ?? '?') + ')'; color = '#b91c1c'; }
      if (f.last_run_at) s += ' · ' + fmtAgo(f.last_run_at);
      if (f.run_stale) s += ' — ⚠ code changed since';
      return { text: s, color };
    },
    fdSummaryHtml() {
      const f = this.fd; if (!f) return '';
      if (f.summary) return esc(f.summary);
      if (this.activeSummaryFileIds.includes(f.id)) return '<span style="color:#9ca3af;font-style:italic;">Generating summary…</span>';
      return `<button class="btn small" data-gen-summary="${f.id}" style="padding:2px 8px;font-size:12px;" title="Click to generate the AI summary">Generate Summary</button>`;
    },
    fdHintHtml() { const f = this.fd; return (f && f.is_source && f.has_main) ? buildHintPanel(f) : ''; },
    async fdToggleStar() { const f = this.fd; if (!f) return; await this.toggleStar(f, !f.starred); },

    // ── file tags ──────────────────────────────────────────────────────────────────────
    fdTagLabel(t) { return (this.fd && this.fd.tag_labels && this.fd.tag_labels[t]) || t; },
    fdAddableTags() {
      const f = this.fd; if (!f) return [];
      const have = new Set(f.tags || []);
      return (f.available_tags || []).filter(t => !have.has(t));
    },
    fdAddTag(tag) {
      const f = this.fd; if (!f || !tag) return;
      if ((f.tags || []).includes(tag)) return;
      this.setFileTags([...(f.tags || []), tag]);
    },
    fdRemoveTag(tag) {
      const f = this.fd; if (!f) return;
      this.setFileTags((f.tags || []).filter(t => t !== tag));
    },
    async setFileTags(tags) {
      const f = this.fd; if (!f) return;
      const prev = (f.tags || []).slice();
      f.tags = tags; f.tags_customized = true;          // optimistic
      this.fdTagsStatus = 'Saving…';
      try {
        const res = await fetch('/api/instructor/file_tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: f.id, tags }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Save failed');
        f.tags = data.tags || tags;
        this.fdTagsStatus = data.reindexed ? 'Saved ✓ — re-indexed for AI' : 'Saved ✓ — indexing pending';
        this.refreshAssignmentFiles();
        setTimeout(() => { this.fdTagsStatus = ''; }, 3000);
      } catch (e) {
        f.tags = prev;                                  // revert
        this.fdTagsStatus = e.message || 'Save failed';
        showNotification(e.message || 'Could not update tags.', true);
      }
    },
    async saveFileContent(confirmed) {
      const f = this.fd; if (!f) return;
      this.fdSaveStatus = 'Saving…'; this.fdBusy = true;
      try {
        const res = await fetch('/api/instructor/file_content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: f.id, content: f.content, confirm: !!confirmed }) });
        const data = await res.json();
        if (data.needs_confirm) { this.fdSaveStatus = ''; this.fdBusy = false; this.fdRisk = { risk: data.risk, reasons: data.reasons || [] }; return; }
        if (!res.ok || data.error) throw new Error(data.error || 'Save failed');
        this.fdRisk = null;
        f._savedContent = f.content;
        this.fdSaveStatus = data.reindexed ? 'Saved ✓ — re-indexed for AI' : 'Saved ✓ — indexing pending';
        this.fdBusy = false;
        this.refreshAssignmentFiles();
        setTimeout(() => { this.fdSaveStatus = ''; }, 3500);
      } catch (e) { this.fdSaveStatus = e.message || 'Save failed'; this.fdBusy = false; }
    },
    fdOpenCompile() { const f = this.fd; if (!f) return; this.closeFileDetail(); this.openCompilePopup(f.id, f.name, f.language); },

    // ── compile & run modal ────────────────────────────────────────────────────────────────────
    async openCompilePopup(fileId, fileName, language) {
      this.compileFileId = fileId;
      this.compileTitle = 'Compile & Run — ' + fileName;
      this.compileSub = (language || '').toUpperCase();
      this.compileState = 'loading'; this.compileError = '';
      this.compileRunStatus = { text: '', color: '' };
      this.compileAnalysis = null; this.compileRun = null; this.compileLastSuccess = null;
      this.compileStdin = '';
      this.compileOpen = true;
      try {
        const f = await fetch(`/api/instructor/file_detail?file_id=${encodeURIComponent(fileId)}`).then(r => r.json());
        if (f.error) throw new Error(f.error);
        this.compileMeta = { analyzed_at: f.last_analysis_at, analysis_stale: f.analysis_stale, run_at: f.last_run_at, run_stale: f.run_stale };
        if (f.last_analysis) this.applyCompileAnalysis(f.last_analysis); else this.compileAnalysis = null;
        this.compileRun = f.last_run || null;
        this.applyRunStatus(f.last_run);
        const hasSuccess = !!f.last_success_run;
        const succRun = hasSuccess ? f.last_success_run : ((f.last_run && f.last_run.ok) ? f.last_run : null);
        const succAt = hasSuccess ? f.last_success_run_at : ((f.last_run && f.last_run.ok) ? f.last_run_at : null);
        const succStale = hasSuccess ? f.success_stale : ((f.last_run && f.last_run.ok) ? f.run_stale : false);
        this.compileLastSuccess = (succRun && succRun.ok) ? { run: succRun, at: succAt, stale: succStale } : null;
        this.compileState = 'ready';
      } catch (err) { this.compileState = 'error'; this.compileError = 'Error: ' + (err.message || 'Failed to load'); }
    },
    closeCompileModal() { this.compileOpen = false; this.compileFileId = null; },
    applyCompileAnalysis(data) { this.compileStdin = data.needs_stdin ? (data.safe_stdin || data.suggested_stdin || '') : this.compileStdin; this.compileAnalysis = data; },
    applyRunStatus(data) {
      if (!data) { this.compileRunStatus = { text: '', color: '' }; return; }
      if (data.security_rejected) { this.compileRunStatus = { text: 'Blocked — not executed', color: '#b91c1c' }; return; }
      this.compileRunStatus = { text: data.ok ? 'Exit 0 (OK)' : ('Exit ' + data.exit_code), color: data.ok ? '#166534' : '#b91c1c' };
    },
    get compileMetaText() {
      const m = this.compileMeta, p = [];
      if (m.analyzed_at) p.push('Analyzed ' + fmtAgo(m.analyzed_at) + (m.analysis_stale ? ' ⚠ code changed since' : ''));
      if (m.run_at) p.push('Last run ' + fmtAgo(m.run_at) + (m.run_stale ? ' ⚠ code changed since' : ''));
      return p.length ? p.join('     ·     ') : 'Not analyzed or run yet — use Analyze / Run below.';
    },
    compileFileIOHtml(data) {
      let h = '';
      if ((data.expected_read_files || []).length) h += `<div><strong>Reads:</strong> ${data.expected_read_files.map(esc).join(', ')}</div>`;
      if ((data.expected_write_files || []).length) h += `<div><strong>Writes:</strong> ${data.expected_write_files.map(esc).join(', ')}</div>`;
      if ((data.aux_files || []).length) h += `<div style="margin-top:4px;color:#0369a1;"><strong>Available in sandbox:</strong> ${data.aux_files.map(esc).join(', ')}</div>`;
      return h || '<em>File I/O detected.</em>';
    },
    compileHasFileIO(d) { return !!d && (d.reads_files || d.writes_files || (d.expected_read_files || []).length || (d.expected_write_files || []).length || (d.aux_files || []).length); },
    compileOutputText(data) {
      if (!data) return '';
      if (data.security_rejected) return '⛔ Blocked before execution (risk: ' + (data.risk || 'high') + ')\n' + (data.reasons || []).map(r => '• ' + r).join('\n') + (data.analysis ? '\n\n' + data.analysis : '');
      let prefix = '';
      const skipped = data.skipped_siblings || [];
      if (skipped.length) prefix = `[Skipped ${skipped.length} sibling file(s) with unresolved dependencies]\n` + skipped.map(s => `  • ${s.filename} (missing: ${(s.missing || []).join(', ')})`).join('\n') + '\n\n';
      return prefix + (data.stdout || data.stderr || '(no output)').trim();
    },
    compileSuccessText(run) {
      let out = (run && run.stdout || '').trim();
      if (!out && run && Array.isArray(run.written_files)) out = run.written_files.map(wf => `[file ${wf.filename || 'output'}]\n${(wf.content || '').trim()}`).filter(Boolean).join('\n\n').trim();
      return out || '(no output)';
    },
    compileLastSuccessMeta() { const s = this.compileLastSuccess; if (!s) return ''; return (s.at ? '— ' + fmtAgo(s.at) : '') + (s.stale ? ' ⚠ code changed since' : ''); },
    async runCompileAnalyze() {
      if (!this.compileFileId) return;
      this.compileBusy.analyze = true;
      try {
        const res = await fetch('/api/instructor/compile_analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: this.compileFileId }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Analysis failed');
        this.applyCompileAnalysis(data);
        this.compileMeta = { ...this.compileMeta, analyzed_at: new Date().toISOString(), analysis_stale: false };
        this.refreshAssignmentFiles();
      } catch (err) { showNotification(err.message || 'Analysis failed', true); }
      finally { this.compileBusy.analyze = false; }
    },
    async submitCompile() {
      if (!this.compileFileId) return;
      this.compileBusy.run = true; this.compileRunStatus = { text: 'Running…', color: '' };
      try {
        const res = await fetch('/api/instructor/compile_run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: this.compileFileId, stdin: this.compileStdin || '' }) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Compilation failed');
        this.compileRun = data;
        this.applyRunStatus(data);
        this.compileMeta = { ...this.compileMeta, run_at: new Date().toISOString(), run_stale: false };
        if (data.ok && !data.security_rejected) this.compileLastSuccess = { run: data, at: new Date().toISOString(), stale: false };
        this.refreshAssignmentFiles();
      } catch (err) { this.compileRunStatus = { text: 'Error: ' + (err.message || 'Run failed'), color: '#b91c1c' }; }
      finally { this.compileBusy.run = false; }
    },


    // ── instructor audit (whole class) ─────────────────────────────────────────────────────────────
    renderInstAuditPanel() {
      if (!this.currentClassId) { this.instAuditState = 'noclass'; return; }
      const asns = this.assignments || [];
      if (!asns.length) { this.instAuditState = 'empty'; this.instAuditSessions = []; return; }
      const ordered = this.currentAsnId ? [asns.find(a => a.id === this.currentAsnId), ...asns.filter(a => a.id !== this.currentAsnId)].filter(Boolean) : asns;
      if (!this.instAuditSelectedAsnId || !asns.find(a => a.id === this.instAuditSelectedAsnId)) this.instAuditSelectedAsnId = ordered[0]?.id || null;
      this.instAuditState = 'ready';
      if (this.instAuditSelectedAsnId) this.loadInstAuditSessions(this.instAuditSelectedAsnId);
    },
    // Sorting shared by the class-audit and assignment-audit session tables.
    sortAudit(key) {
      if (this.auditSort.key === key) {
        this.auditSort.dir = this.auditSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        this.auditSort = { key, dir: key === 'started_at' ? 'desc' : 'asc' };
      }
    },
    sortArrow(key) {
      if (this.auditSort.key !== key) return '';
      return this.auditSort.dir === 'asc' ? ' ▲' : ' ▼';
    },
    _sortAuditSessions(list) {
      const { key, dir } = this.auditSort;
      const mult = dir === 'asc' ? 1 : -1;
      const val = (s) => key === 'thread_label' ? (s.thread_label || 'Session') : (s[key] || '');
      // Help-flagged threads ("I'm still stuck") always float to the top, whatever the
      // column sort — a struggling student must be the first thing the instructor sees.
      return [...(list || [])].sort((a, b) =>
        (Number(!!b.help_flagged) - Number(!!a.help_flagged)) ||
        mult * String(val(a)).localeCompare(String(val(b)), undefined, { numeric: true, sensitivity: 'base' }));
    },
    get sortedAsnAuditSessions() { return this._sortAuditSessions(this.asnAuditSessions); },
    get sortedInstAuditSessions() { return this._sortAuditSessions(this.instAuditSessions); },

    get instAuditOrderedAsns() {
      const asns = this.assignments || [];
      return this.currentAsnId ? [asns.find(a => a.id === this.currentAsnId), ...asns.filter(a => a.id !== this.currentAsnId)].filter(Boolean) : asns;
    },
    selectInstAuditAsn(id) { this.instAuditSelectedAsnId = id; this.loadInstAuditSessions(id); },
    async loadInstAuditSessions(asnId) {
      this.asnAuditState = this.asnAuditState; // noop keep
      this.instAuditSessions = []; this._instAuditLoading = true;
      try {
        const res = await fetch(`/api/instructor/audit/sessions/${encodeURIComponent(asnId)}`);
        const data = await res.json();
        if (!res.ok) { this.instAuditSessions = []; this._instAuditLoading = false; return; }
        this.instAuditSessions = data.sessions || [];
      } catch { this.instAuditSessions = []; }
      this._instAuditLoading = false;
    },

    // ── assignment audit (current assignment) ─────────────────────────────────────────────────────────
    renderAsnAuditPanel() {
      if (!this.currentAsnId) { this.asnAuditState = 'empty'; return; }
      this.asnAuditState = 'ready';
      this.loadAsnAuditSessions(this.currentAsnId);
      this.loadAsnIssues(this.currentAsnId);
    },

    // ── manual refresh (⟳ icons) — re-pull the lists in place, no page reload ─────────────────────────
    refreshAsnAudit() {
      if (!this.currentAsnId) return;
      this.loadAsnAuditSessions(this.currentAsnId);
      this.loadAsnIssues(this.currentAsnId);
    },
    refreshInstAudit() {
      if (this.instAuditSelectedAsnId) this.loadInstAuditSessions(this.instAuditSelectedAsnId);
    },
    async refreshTutoring() {
      if (!this.currentAsnId) return;
      // loadTutLinks rebuilds the list with every expander collapsed — remember which
      // links were open and re-open them (their chat lists re-fetch too).
      const openIds = new Set(this.tutLinks.filter(l => l._open).map(l => l.id));
      this.loadTutThreads();
      await this.loadTutLinks();
      this.tutLinks.forEach(l => { if (openIds.has(l.id)) { l._open = true; this.loadLinkChats(l); } });
    },

    // "Needs attention" strip: students' latest FAILING runs (file + first error line —
    // LeafTutor has usually already located the typo) plus help-flagged threads.
    asnIssues: { issues: [], flagged: [] },
    async loadAsnIssues(asnId) {
      this.asnIssues = { issues: [], flagged: [] };
      try {
        const res = await fetch(`/api/instructor/audit/issues/${encodeURIComponent(asnId)}`);
        const data = await res.json();
        if (asnId !== this.currentAsnId || !res.ok) return;
        this.asnIssues = { issues: data.issues || [], flagged: data.flagged || [] };
      } catch { /* leave empty */ }
    },
    async resolveHelp(sessionId) {
      try {
        const r = await fetch(`/api/instructor/audit/resolve_help/${encodeURIComponent(sessionId)}`, { method: 'POST' });
        if (!r.ok) return;
        // Refresh both views so the badge and the strip clear together.
        if (this.currentAsnId) { this.loadAsnAuditSessions(this.currentAsnId); this.loadAsnIssues(this.currentAsnId); }
        if (this.instAuditSelectedAsnId) this.loadInstAuditSessions(this.instAuditSelectedAsnId);
      } catch { /* network hiccup — instructor can retry */ }
    },
    async dismissIssue(fileId) {
      try {
        const r = await fetch(`/api/instructor/audit/dismiss_issue/${encodeURIComponent(fileId)}`, { method: 'POST' });
        if (!r.ok) return;
        if (this.currentAsnId) this.loadAsnIssues(this.currentAsnId);
      } catch { /* network hiccup — instructor can retry */ }
    },
    async loadAsnAuditSessions(asnId) {
      this.asnAuditSessions = [];
      try {
        const res = await fetch(`/api/instructor/audit/sessions/${encodeURIComponent(asnId)}`);
        const data = await res.json();
        if (asnId !== this.currentAsnId) return;
        if (!res.ok) { this.asnAuditSessions = []; return; }
        this.asnAuditSessions = data.sessions || [];
      } catch { this.asnAuditSessions = []; }
    },

    // ── audit conversation modal ─────────────────────────────────────────────────────────────────────
    async openInstAuditChat(sessionId, studentName, startedAt, threadLabel) {
      this.auditTitle = studentName + (threadLabel ? ` — ${threadLabel}` : '');
      this.auditSub = `Session started ${fmtDateTime(startedAt)}`;
      this.auditFiles = []; this.auditMessages = []; this.auditState = 'loading'; this.auditOpen = true;
      this.auditSessionId = sessionId; this.auditClosed = false; this.auditCanClose = false;
      try {
        const res = await fetch(`/api/instructor/audit/messages/${encodeURIComponent(sessionId)}`);
        const data = await res.json();
        if (!res.ok) { this.auditState = 'error'; this.auditError = data.error || 'Failed'; return; }
        const msgs = data.messages || [];
        this.auditFiles = msgs.filter(m => m.role === 'file');
        this.auditMessages = msgs;
        this.auditClosed = !!data.closed;
        this.auditCanClose = !!data.can_close;
        this.auditState = msgs.length ? 'ready' : 'empty';
      } catch { this.auditState = 'error'; this.auditError = 'Network error.'; }
    },
    // Close session = the student/anon owner can still read the chat but not add to it.
    async toggleAuditClosed() {
      if (!this.auditSessionId || this.auditClosing) return;
      this.auditClosing = true;
      try {
        const res = await fetch(`/api/instructor/audit/toggle_closed/${encodeURIComponent(this.auditSessionId)}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showNotification(data.error || 'Failed', true); return; }
        this.auditClosed = !!data.closed;
        showNotification(this.auditClosed ? 'Session closed — the participant can view it but not add to it.' : 'Session reopened.');
      } catch { showNotification('Network error', true); }
      finally { this.auditClosing = false; }
    },
    closeInstAuditModal() { this.auditOpen = false; },

    // ── tutoring panel ───────────────────────────────────────────────────────────────────────────────────
    renderAsnTutoringPanel() {
      if (!this.currentAsnId) return;
      this.tutNewChatOpen = false; this.tutNewLinkOpen = false;
      this.closeTutThread(true);
      this.loadTutThreads();
      this.loadTutLinks();
      Alpine.nextTick(() => this.fitTutoring());
    },
    fitTutoring() {
      const body = $id('asnTutoringBody');
      if (!body || this.asnTab !== 'tutoring' || !this.currentAsnId) return;
      requestAnimationFrame(() => { const rect = body.getBoundingClientRect(); body.style.maxHeight = Math.max(160, window.innerHeight - rect.top - 16) + 'px'; body.style.overflowY = 'auto'; });
    },
    async loadTutThreads() {
      const asnId = this.currentAsnId;
      this.tutThreadState = 'loading'; this.tutThreads = [];
      try {
        const res = await fetch(`/api/instructor/tutoring/threads?assignment_id=${encodeURIComponent(asnId)}`);
        const data = await res.json();
        if (asnId !== this.currentAsnId) return;
        if (!res.ok) { this.tutThreadState = 'error'; return; }
        this.tutThreads = data.threads || [];
        this.tutThreadState = this.tutThreads.length ? 'ready' : 'empty';
      } catch { this.tutThreadState = 'error'; }
    },
    tutThreadMeta(t) { return `${t.message_count} msg${t.message_count === 1 ? '' : 's'} · ${tutFmtTime(t.updated_at)}`; },
    showTutNewChat() { if (!this.currentAsnId) return; this.tutNewChatName = ''; this.tutNewChatOpen = true; Alpine.nextTick(() => $id('tutNewChatName')?.focus()); },
    hideTutNewChat() { this.tutNewChatOpen = false; },
    onTutNewChatKey(e) { if (e.key === 'Enter') { e.preventDefault(); this.submitTutNewChat(); } else if (e.key === 'Escape') this.hideTutNewChat(); },
    async submitTutNewChat() {
      if (!this.currentAsnId) return;
      const title = (this.tutNewChatName || '').trim() || 'Tutoring chat';
      try {
        const res = await fetch('/api/instructor/tutoring/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignment_id: this.currentAsnId, title }) });
        const data = await res.json();
        if (!res.ok) { showNotification(data.error || 'Could not create chat', true); return; }
        this.hideTutNewChat();
        this.openTutThread(data.thread.id);
      } catch { showNotification('Network error', true); }
    },
    openTutThread(threadId) {
      this.tutThreadId = threadId; this.tutThreadAsnId = this.currentAsnId;
      this.tutView = 'chat'; this.tutQuestion = ''; this.tutComposerStatus = '';
      this.tutRenameEditing = false;
      this.tutThread = (this.tutThreads || []).find(t => t.id === threadId) || null;
      this.loadTutMessages(threadId);
    },
    closeTutThread(skipReload) { this.tutThreadId = null; this.tutView = 'list'; if (!skipReload) this.loadTutThreads(); },
    async loadTutMessages(threadId) {
      this.tutMsgState = 'loading'; this.tutMessages = []; this.tutFiles = [];
      try {
        const res = await fetch(`/api/instructor/tutoring/messages?thread_id=${encodeURIComponent(threadId)}`);
        const data = await res.json();
        if (this.tutThreadId !== threadId) return;
        if (!res.ok) { this.tutMsgState = 'error'; return; }
        this.tutRenameEditing = false;
        this.tutThread = data.thread || null;   // drives ownsThread/canEditTutThread gating
        this.tutThreadTitle = data.thread.title || 'Tutoring chat';
        this.tutFiles = data.files || [];
        const msgs = (data.messages || []).filter(m => m.role !== 'system');
        this.tutMessages = msgs;
        this.tutMsgState = msgs.length ? 'ready' : 'empty';
        Alpine.nextTick(() => { const b = $id('tutMessages'); if (b) b.scrollTop = b.scrollHeight; });
      } catch { this.tutMsgState = 'error'; }
    },
    tutFileLineAction(m) { return (m.extra && m.extra.action) === 'run' ? '' : ' (attached — click to open)'; },
    tutFileLineId(m) { return (m.extra && m.extra.file_id) || ''; },
    async sendTutQuestion() {
      if (this.tutSending || !this.tutThreadId) return;
      const q = (this.tutQuestion || '').trim();
      this.tutSending = true; this.tutComposerStatus = 'Thinking…';
      try {
        const res = await fetch('/api/instructor/tutoring/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thread_id: this.tutThreadId, question: q }) });
        const data = await res.json();
        if (!res.ok) { showNotification(data.error || 'Failed', true); this.tutComposerStatus = ''; return; }
        this.tutQuestion = '';
        this.tutComposerStatus = data.failed ? 'Saved for retry — generation failed.' : '';
        await this.loadTutMessages(this.tutThreadId);
      } catch { showNotification('Network error', true); }
      finally { this.tutSending = false; }
    },
    startTutRename() { if (!this.tutThreadId) return; this.tutRenameValue = this.tutThreadTitle; this.tutRenameEditing = true; Alpine.nextTick(() => { const i = $id('tutThreadTitleInput'); if (i) { i.focus(); i.select(); } }); },
    onTutRenameKey(e) { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } else if (e.key === 'Escape') { this._tutRenameCancel = true; e.target.blur(); } },
    async commitTutRename() {
      if (!this.tutRenameEditing) return;
      this.tutRenameEditing = false;
      if (this._tutRenameCancel) { this._tutRenameCancel = false; return; }
      const t = (this.tutRenameValue || '').trim();
      if (!t || t === this.tutThreadTitle) return;
      try {
        const res = await fetch(`/api/instructor/tutoring/threads/${encodeURIComponent(this.tutThreadId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t }) });
        const data = await res.json();
        if (!res.ok) { showNotification(data.error || 'Rename failed', true); return; }
        this.tutThreadTitle = data.thread.title;
      } catch { showNotification('Network error', true); }
    },
    async deleteTutThread() {
      if (!this.tutThreadId) return;
      if (!confirm('Delete this tutoring chat and its attached files? This cannot be undone.')) return;
      try {
        const res = await fetch(`/api/instructor/tutoring/threads/${encodeURIComponent(this.tutThreadId)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) { showNotification(data.error || 'Failed', true); return; }
        showNotification('Tutoring chat deleted');
        this.closeTutThread();
      } catch { showNotification('Network error', true); }
    },
    async uploadTutFile(e) {
      const input = e.target;
      if (!this.tutThreadId || !input.files || !input.files.length) return;
      const fd = new FormData(); fd.append('thread_id', this.tutThreadId); fd.append('file', input.files[0]); input.value = '';
      this.tutComposerStatus = 'Uploading…';
      try {
        const res = await fetch('/api/instructor/tutoring/upload', { method: 'POST', body: fd });
        const data = await res.json();
        this.tutComposerStatus = '';
        if (!res.ok) { showNotification(data.error || 'Upload failed', true); return; }
        await this.loadTutMessages(this.tutThreadId);
      } catch { showNotification('Network error', true); this.tutComposerStatus = ''; }
    },
    triggerTutFileInput() { $id('tutFileInput')?.click(); },

    // tut paste modal
    openTutPaste() { if (!this.tutThreadId) return; this.tutPaste = { name: '', content: '' }; this.tutPasteStatus = ''; this.tutPasteOpen = true; },
    closeTutPaste() { this.tutPasteOpen = false; },
    async submitTutPaste() {
      if (!this.tutThreadId) return;
      const filename = (this.tutPaste.name || '').trim(), content = this.tutPaste.content || '';
      if (!content.trim()) { this.tutPasteStatus = 'Paste some code first.'; return; }
      this.tutPasteStatus = 'Adding…';
      try {
        const res = await fetch('/api/instructor/tutoring/paste_file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thread_id: this.tutThreadId, filename, content }) });
        const data = await res.json();
        if (!res.ok) { this.tutPasteStatus = data.error || 'Failed'; return; }
        this.closeTutPaste();
        await this.loadTutMessages(this.tutThreadId);
      } catch { this.tutPasteStatus = 'Network error'; }
    },

    // tut file modal
    async openTutFile(fileId) {
      if (!this.tutThreadId || !fileId) return;
      this.tutFileId = fileId;
      this.tutFile = null; this.tutFileContent = ''; this.tutFileStatus = ''; this.tutFileResultHtml = ''; this.tutFileStdin = '';
      this.tutFileOpen = true;
      try {
        const res = await fetch(`/api/instructor/tutoring/file_detail?thread_id=${encodeURIComponent(this.tutThreadId)}&file_id=${encodeURIComponent(fileId)}`);
        const data = await res.json();
        if (!res.ok) { this.tutFile = { name: 'Error' }; this.tutFileStatus = data.error || 'Failed'; return; }
        this.tutFile = data;
        this.tutFileContent = data.content || (data.content_error ? '' : (data.summary || ''));
        if (data.content_error) this.tutFileStatus = data.content_error;
        if (data.last_run) this.tutFileResultHtml = renderTutFileResult(data.last_run, 'Last run');
      } catch { this.tutFile = { name: 'Network error' }; }
    },
    closeTutFile() { this.tutFileOpen = false; this.tutFileId = null; },
    tutFileSub() { const d = this.tutFile; if (!d) return ''; return [d.language || '', d.editable ? 'editable' : 'read-only'].filter(Boolean).join(' · '); },
    async saveTutFile() {
      if (!this.tutFileId) return;
      this.tutFileStatus = 'Saving…';
      try {
        const res = await fetch('/api/instructor/tutoring/file_content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thread_id: this.tutThreadId, file_id: this.tutFileId, content: this.tutFileContent }) });
        const data = await res.json();
        this.tutFileStatus = res.ok ? 'Saved.' : (data.error || 'Save failed');
      } catch { this.tutFileStatus = 'Network error'; }
    },
    async analyzeTutFile() {
      if (!this.tutFileId) return;
      this.tutFileStatus = 'Analyzing…'; this.tutFileResultHtml = '';
      try {
        const res = await fetch('/api/instructor/tutoring/file_analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thread_id: this.tutThreadId, file_id: this.tutFileId }) });
        const data = await res.json();
        this.tutFileStatus = '';
        if (!res.ok) { this.tutFileStatus = data.error || 'Analysis failed'; return; }
        const parts = [];
        if (data.summary) parts.push(`<b>Summary:</b> ${esc(data.summary)}`);
        if (data.purpose) parts.push(`<b>Purpose:</b> ${esc(data.purpose)}`);
        if (Array.isArray(data.issues) && data.issues.length) parts.push(`<b>Issues:</b><ul style="margin:4px 0 0 16px;">${data.issues.map(i => `<li>${esc(typeof i === 'string' ? i : JSON.stringify(i))}</li>`).join('')}</ul>`);
        this.tutFileResultHtml = parts.length ? `<div class="card" style="font-size:12.5px;line-height:1.5;">${parts.join('<br>')}</div>` : `<div class="card" style="font-size:12px;"><pre style="white-space:pre-wrap;margin:0;">${esc(JSON.stringify(data, null, 2))}</pre></div>`;
      } catch { this.tutFileStatus = 'Network error'; }
    },
    async runTutFile() {
      if (!this.tutFileId) return;
      this.tutFileStatus = 'Compiling & running…'; this.tutFileResultHtml = '';
      try {
        const res = await fetch('/api/instructor/tutoring/file_run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thread_id: this.tutThreadId, file_id: this.tutFileId, stdin: this.tutFileStdin || '' }) });
        const data = await res.json();
        this.tutFileStatus = '';
        if (!res.ok) { this.tutFileStatus = data.error || 'Run failed'; return; }
        this.tutFileResultHtml = renderTutFileResult(data, 'Result');
        if (this.tutThreadId) this.loadTutMessages(this.tutThreadId);
      } catch { this.tutFileStatus = 'Network error'; }
    },

    // ── anonymous links ──────────────────────────────────────────────────────────────────────────────────
    copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => showNotification('Copied'), () => window.prompt('Copy:', text));
      else window.prompt('Copy:', text);
    },
    showTutNewLink() { if (!this.currentAsnId) return; this.tutNewLink = { alias: '', pwEnabled: false, pw: '' }; this.tutNewLinkStatus = ''; this.tutNewLinkOpen = true; Alpine.nextTick(() => $id('tutNewLinkAlias')?.focus()); },
    hideTutNewLink() { this.tutNewLinkOpen = false; },
    async submitTutNewLink() {
      if (!this.currentAsnId) return;
      this.tutNewLinkStatus = 'Creating…';
      try {
        const res = await fetch('/api/instructor/tutoring/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignment_id: this.currentAsnId, alias: (this.tutNewLink.alias || '').trim(), password_enabled: this.tutNewLink.pwEnabled, password: (this.tutNewLink.pw || '').trim() }) });
        const data = await res.json();
        if (!res.ok) { this.tutNewLinkStatus = data.error || 'Failed'; return; }
        this.hideTutNewLink();
        this.loadTutLinks();
      } catch { this.tutNewLinkStatus = 'Network error'; }
    },
    async loadTutLinks() {
      const asnId = this.currentAsnId;
      this.tutLinkState = 'loading'; this.tutLinks = [];
      try {
        const res = await fetch(`/api/instructor/tutoring/links?assignment_id=${encodeURIComponent(asnId)}`);
        const data = await res.json();
        if (asnId !== this.currentAsnId) return;
        if (!res.ok) { this.tutLinkState = 'error'; return; }
        this.tutLinks = (data.links || []).map(l => ({ ...l, _pwEnabled: !!l.password_enabled, _pw: l.password || '', _open: false, _chats: [], _chatState: 'idle' }));
        this.tutLinkState = this.tutLinks.length ? 'ready' : 'empty';
      } catch { this.tutLinkState = 'error'; }
    },
    async updateLink(l, patch) {
      try {
        const res = await fetch(`/api/instructor/tutoring/links/${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        const data = await res.json();
        if (!res.ok) {
          showNotification(data.error || 'Update failed', true);
          this.loadTutLinks();
          return false;
        }
        return true;
      } catch {
        showNotification('Network error', true);
        return false;
      }
    },
    saveLinkPassword(l) {
      this.updateLink(l, { password_enabled: l._pwEnabled, password: l._pw || '' })
        .then(ok => { if (ok) showNotification('Password saved'); });
    },
    async deleteLink(l) {
      if (!confirm('Delete this link? Its existing chats are kept for audit but the link stops working.')) return;
      try { const res = await fetch(`/api/instructor/tutoring/links/${encodeURIComponent(l.id)}`, { method: 'DELETE' }); if (res.ok) { showNotification('Link deleted'); this.loadTutLinks(); } else { const d = await res.json(); showNotification(d.error || 'Failed', true); } }
      catch { showNotification('Network error', true); }
    },
    toggleLinkChats(l) { l._open = !l._open; if (l._open) this.loadLinkChats(l); },
    async loadLinkChats(l) {
      l._chatState = 'loading'; l._chats = [];
      try {
        const res = await fetch(`/api/instructor/tutoring/links/${encodeURIComponent(l.id)}/chats`);
        const data = await res.json();
        if (!res.ok) { l._chatState = 'error'; return; }
        l._chats = data.chats || [];
        l._chatState = l._chats.length ? 'ready' : 'empty';
      } catch { l._chatState = 'error'; }
    },
    anonChatName(c) { return (c.alias && c.alias.trim()) ? c.alias : 'Anonymous chat'; },
    viewAnonChat(c) { this.openInstAuditChat(c.session_id, this.anonChatName(c), c.started_at, 'anonymous'); },
    async setAnonChatDisabled(l, c, disabled) {
      try { const res = await fetch(`/api/instructor/tutoring/anon_chats/${encodeURIComponent(c.session_id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anon_disabled: disabled }) }); if (res.ok) this.loadLinkChats(l); else { const d = await res.json(); showNotification(d.error || 'Failed', true); } }
      catch { showNotification('Network error', true); }
    },
    // Close = the visitor can still open and read the chat but not add to it (view-only).
    async setAnonChatClosed(l, c, closed) {
      try { const res = await fetch(`/api/instructor/tutoring/anon_chats/${encodeURIComponent(c.session_id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ closed }) }); if (res.ok) this.loadLinkChats(l); else { const d = await res.json(); showNotification(d.error || 'Failed', true); } }
      catch { showNotification('Network error', true); }
    },
    async deleteAnonChat(l, c) {
      if (!confirm('Delete this anonymous chat and its transcript? This cannot be undone.')) return;
      try { const res = await fetch(`/api/instructor/tutoring/anon_chats/${encodeURIComponent(c.session_id)}`, { method: 'DELETE' }); if (res.ok) { showNotification('Chat deleted'); this.loadLinkChats(l); this.loadTutLinks(); } else { const d = await res.json(); showNotification(d.error || 'Failed', true); } }
      catch { showNotification('Network error', true); }
    },
  });
});

// ── HTML builders reused inside x-html (mirror the originals; values escaped) ──
function buildHintPanel(f) {
  // Read-only: hints are managed from the Project Compilation overlay (Auto-gen).
  const bodyId = `hint-body-${f.id}`, chevId = `hint-chev-${f.id}`;
  const hasHint = !!f.compilation_hint, isStale = !!f.hint_stale;
  const hintAt = f.compilation_hint_at ? fmtDateTime(f.compilation_hint_at) : null;
  let badge = '';
  if (hasHint && isStale) badge = '<span class="hint-badge hint-badge-stale">Stale</span>';
  else if (hasHint) badge = '<span class="hint-badge hint-badge-auto">Auto</span>';
  const staleWarn = (hasHint && isStale) ? `<div class="hint-stale-warn">&#9888; Materials updated after this note was generated — run Auto-gen in the Generate Hints overlay to refresh it.</div>` : '';
  const dateNote = hintAt ? `<span class="hint-status">${isStale ? 'Last generated' : 'Generated'}: ${escapeHtml(hintAt)}</span>` : '';
  const startOpen = isStale;
  return `<div class="hint-panel">
    <div class="hint-panel-hdr" onclick="toggleHintPanel('${bodyId}','${chevId}')">
      <span>Compilation Hint</span>${badge}
      <span class="hint-chevron" id="${chevId}">${startOpen ? '▲' : '▼'}</span>
    </div>
    <div class="hint-body" id="${bodyId}" style="display:${startOpen ? '' : 'none'}">
      ${staleWarn}
      <pre class="gh-item-text" style="max-height:160px;">${escapeHtml(f.compilation_hint || 'No note yet — use Auto-gen in the Generate Hints overlay.')}</pre>
      <div class="hint-actions">${dateNote}</div>
    </div>
  </div>`;
}
function renderTutFileResult(data, label) {
  if (data.security_rejected)
    return `<div class="card" style="font-size:12.5px;"><b>⚠ Not executed (flagged risky — ${escapeHtml(data.risk || '')})</b><div style="margin-top:6px;white-space:pre-wrap;">${escapeHtml(data.analysis || '')}</div></div>`;
  const ok = data.ok ? '✅ OK' : `❌ ${escapeHtml(data.phase || 'failed')}`;
  const out = data.output || data.stderr || data.stdout || 'No output.';
  const diff = (typeof autoRepairDiffHtml === 'function') ? autoRepairDiffHtml(data.auto_repair_diff) : '';
  return `<div class="card" style="font-size:12px;"><div style="margin-bottom:4px;"><b>${escapeHtml(label || 'Result')}:</b> ${ok}</div><pre style="white-space:pre-wrap;margin:0;max-height:260px;overflow:auto;">${escapeHtml(out)}</pre>${diff}</div>`;
}

// ── Global shims for handlers embedded in x-html content + the server roster partial ──
function toggleHintPanel(bodyId, chevId) {
  const body = document.getElementById(bodyId), chev = document.getElementById(chevId);
  if (!body) return;
  const opening = body.style.display === 'none';
  body.style.display = opening ? '' : 'none';
  if (chev) chev.textContent = opening ? '▲' : '▼';
}
async function generateDep(fileId, depName, btn) {
  const row = btn.closest('div[id^="dep_row_"]') || btn.parentElement;
  const statusEl = row.querySelector('.dep-gen-status');
  btn.disabled = true; if (statusEl) { statusEl.textContent = 'Generating…'; statusEl.style.color = ''; }
  try {
    const res = await fetch('/api/instructor/compile_generate_dep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId, dep_name: depName }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Generation failed');
    btn.textContent = 'Generated'; btn.style.cssText += ';background:#166534;color:#fff;';
    if (statusEl) { statusEl.textContent = data.filename; statusEl.style.color = '#166534'; }
    Alpine.store('inst').refreshAssignmentFiles();
  } catch (e) { btn.disabled = false; if (statusEl) { statusEl.textContent = 'Error: ' + (e.message || 'Failed'); statusEl.style.color = '#b91c1c'; } }
}
// Server-rendered roster partial calls these:
function toggleStudent(studentId) { Alpine.store('inst').toggleStudent(studentId); }
function studentResetLink(enrollId, name) { Alpine.store('inst').openStudentResetLink(enrollId, name); }
// Summary "Generate" button inside the file-detail modal (delegated):
document.addEventListener('click', e => {
  const b = e.target.closest('[data-gen-summary]');
  if (!b) return;
  e.stopPropagation();
  b.disabled = true; b.textContent = 'Generating…';
  Alpine.store('inst').regenerateSummary(b.getAttribute('data-gen-summary'));
});
