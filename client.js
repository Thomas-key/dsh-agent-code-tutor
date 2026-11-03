/**
 * 设置页的客户端半 —— 在设置左侧导航里加一个独立页。
 *
 * 为什么必须有这一半:Host 只导出 Config schema 不会自动生成页面。
 * 设置里的每一页(费用、快照、状态文案、语音模式……)都是插件自己的客户端模块
 * 注册进 `settings.section` 槽渲染的,没有它就什么都没有。
 *
 * 页面内容:
 *   端口           —— 一个数字输入
 *   会话绑定       —— 列表:每行「会话标题 / token / 删除」,➕ 从会话列表里挑,不用手打 id
 *
 * 绑定表在配置里仍是一个字符串(`sessionId=token;...`),这里负责解析和回写 ——
 * 用户看到的是列表,存下去的是那串东西。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-code-tutor',
  factory(require) {
    const React = require('react');

    /** 设置命名空间候选 —— row id 与 loader 入口 id,哪个 ready 用哪个。 */
    const SETTINGS_NS_CANDIDATES = ['dsh-agent-code-tutor', 'include:dsh-agent-code-tutor'];
    const LOCALE_NS = 'settings.codeTutor';

    const zh = {
      title: '编辑器陪读',
      port: '端口',
      portHint: 'VS Code 扩展监听的端口,要和编辑器设置 tutorApi.port 一致。默认 41890。',
      bindingsTitle: '会话绑定',
      bindingsHint:
        '把编辑器工作区和 DSH 会话配对:选中一个会话、填上那块编辑器的 token。' +
        '编辑器里问的话就会送到这里选的会话。',
      add: '添加',
      addTitle: '新增绑定',
      pickSession: '选择会话',
      pickPlaceholder: '— 选一个会话 —',
      tokenLabel: 'token',
      tokenPlaceholder: '编辑器设置 tutorApi.conversationToken 的值',
      confirm: '添加',
      cancel: '取消',
      remove: '删除',
      empty: '还没有绑定。点「添加」把某个会话和一块编辑器配起来。',
      noSessions: '没有可选的会话了(可能都绑定过了)。',
      allBound: '所有会话都已绑定。',
      unavailable: '这个页面暂时拿不到配置(设置服务不可用)。',
      fallback: '当前可以在插件目录下的 config.json 里改 port / bindings,或设置环境变量 EDITOR_API_PORT / EDITOR_API_BINDINGS。',
      readOnly: '只读',
      saveFailed: '保存失败',
      save: '保存',
      saving: '保存中…',
      overridden: '已修改',
      reset: '恢复默认',
      invalidNumber: '要填一个数字',
    };

    const en = {
      title: 'Editor Tutor',
      port: 'Port',
      portHint: 'The port the VS Code extension listens on. Must match the editor setting tutorApi.port. Default 41890.',
      bindingsTitle: 'Session bindings',
      bindingsHint:
        'Pair an editor workspace with a DSH session: pick a session and fill in that editor window token. ' +
        'Questions asked in the editor are delivered to the chosen session.',
      add: 'Add',
      addTitle: 'New binding',
      pickSession: 'Session',
      pickPlaceholder: '— pick a session —',
      tokenLabel: 'token',
      tokenPlaceholder: 'the editor setting tutorApi.conversationToken value',
      confirm: 'Add',
      cancel: 'Cancel',
      remove: 'Remove',
      empty: 'No bindings yet. Press Add to pair a session with an editor window.',
      noSessions: 'No sessions left to pick (they may all be bound).',
      allBound: 'Every session is already bound.',
      unavailable: 'This page cannot read its configuration right now (settings service unavailable).',
      fallback: 'For now edit port / bindings in the plugin directory config.json, or set EDITOR_API_PORT / EDITOR_API_BINDINGS.',
      readOnly: 'Read only',
      saveFailed: 'Save failed',
      save: 'Save',
      saving: 'Saving…',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidNumber: 'Expected a number',
    };

    // ── 绑定表的解析 / 序列化(格式与 Host 侧 parseBindings 一致)──────────

    function parseBindings(text) {
      const entries = [];
      for (const raw of String(text ?? '').split(/[\n;]/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = /^([^\s=]+)\s*[=]?\s*([^\s=]+)$/.exec(line);
        if (!match) continue;
        entries.push({ sessionId: match[1], token: match[2] });
      }
      return entries;
    }

    function serializeBindings(entries) {
      return entries.map((entry) => `${entry.sessionId}=${entry.token}`).join('; ');
    }

    /** 只读说明页 —— 表单构建失败时的兜底,保证页面一定存在。 */
    function fallbackPage(t) {
      return function Fallback() {
        return React.createElement(
          'div',
          { style: { display: 'grid', gap: 8, fontSize: 13 } },
          React.createElement('div', { style: { fontWeight: 600 } }, t('title')),
          React.createElement('div', null, t('unavailable')),
          React.createElement('div', { style: { opacity: 0.7, lineHeight: 1.6 } }, t('fallback')),
        );
      };
    }

    // ── 页面 ──────────────────────────────────────────────────────

    function buildFormPage(ctx, t) {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const { SettingsFormModel, SettingsForm, SettingsValueField, settingsNumberField, settingsTextField } = primitives;
        const configForms = ctx.get?.('configForms');
        if (!configForms || typeof configForms.get !== 'function') return undefined;

        const candidates = SETTINGS_NS_CANDIDATES.map((ns) => {
          const scope = configForms.get(ns);
          // bindings 仍是一个字符串字段 —— 自定义界面负责把它变成列表
          const model = new SettingsFormModel(scope, [settingsNumberField('port'), settingsTextField('bindings')]);
          return { ns, scope, model, actions: model.actions() };
        });
        ctx.effect(() => () => candidates.forEach(({ model }) => model.dispose()), 'code-tutor:forms');

        const pick = () => {
          for (const item of candidates) {
            try {
              if (item.model.shell().available) return item;
            } catch {}
          }
          return undefined;
        };

        /**
         * 颜色一律走主题 token(CSS 变量 `--dsw-alias-*`),不写死。
         *
         * 第二个参数是兜底:万一某个部署没定义这个变量,界面还在,
         * 只是退回中性灰 —— 而不是变成白底白字。
         */
        const TOKEN = {
          overlayBg: 'var(--dsw-alias-bg-overlay, rgba(30,30,30,0.92))',
          layerBg: 'var(--dsw-alias-bg-layer-2, transparent)',
          border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
          separator: 'var(--dsw-alias-separator-primary, rgba(128,128,128,0.18))',
          label: 'var(--dsw-alias-label-primary, inherit)',
          labelSecondary: 'var(--dsw-alias-label-secondary, inherit)',
          selectedBg: 'var(--dsw-alias-interactive-bg-active, rgba(128,128,128,0.30))',
        };

        const styles = {
          wrap: { display: 'grid', gap: 10, fontSize: 13, color: TOKEN.label },
          head: { fontWeight: 600 },
          hint: { color: TOKEN.labelSecondary, lineHeight: 1.6, fontSize: 12 },
          row: {
            display: 'grid',
            gridTemplateColumns: '1fr minmax(0, 220px) auto',
            gap: 8,
            alignItems: 'center',
            padding: '6px 0',
            borderBottom: `1px solid ${TOKEN.separator}`,
          },
          sessionName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          muted: { color: TOKEN.labelSecondary, fontSize: 11 },
          input: {
            background: TOKEN.layerBg,
            border: `1px solid ${TOKEN.border}`,
            borderRadius: 6,
            padding: '4px 8px',
            color: TOKEN.label,
            font: 'inherit',
            minWidth: 0,
          },
          pickerWrap: { position: 'relative', minWidth: 0 },
          // 浮层:用主题的"浮层背景"token,深浅主题都自动对
          popover: {
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            minWidth: 280,
            maxHeight: 240,
            overflowY: 'auto',
            display: 'grid',
            gap: 2,
            padding: 4,
            zIndex: 50,
            borderRadius: 8,
            border: `1px solid ${TOKEN.border}`,
            background: TOKEN.overlayBg,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          },
          pickerItem: {
            textAlign: 'left',
            border: 'none',
            borderRadius: 4,
            padding: '4px 6px',
            font: 'inherit',
            color: TOKEN.label,
            cursor: 'pointer',
            background: 'transparent',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
          button: {
            background: 'transparent',
            border: `1px solid ${TOKEN.border}`,
            borderRadius: 6,
            padding: '4px 10px',
            color: TOKEN.label,
            font: 'inherit',
            cursor: 'pointer',
          },
        };

        return function SettingsPage(props) {
          const [, bump] = React.useState(0);
          const rerender = () => bump((value) => value + 1);

          React.useEffect(() => {
            const unsubscribers = candidates
              .map(({ scope }) => (typeof scope?.subscribe === 'function' ? scope.subscribe(() => rerender()) : undefined))
              .filter(Boolean);
            return () => unsubscribers.forEach((fn) => fn());
          }, []);

          // 会话列表由宿主通过标准 props 提供:标题 + cwd,足够做选择器
          const useSessions = props?.useSessions;
          const sessions = useSessions
            ? useSessions((state) =>
                (state.ids ?? [])
                  .map((id) => state.byId?.[id])
                  .filter(Boolean)
                  .map((session) => ({
                    id: session.id,
                    title: session.displayTitle ?? session.title ?? session.id,
                    cwd: session.cwd ?? '',
                  })),
              )
            : [];

          const [adding, setAdding] = React.useState(false);
          const [draftSession, setDraftSession] = React.useState('');
          const [draftToken, setDraftToken] = React.useState('');
          const [pickerOpen, setPickerOpen] = React.useState(false);
          const pickerRef = React.useRef(null);

          // 点外面收起浮层 —— 浮层盖在别的控件上时必须有这个
          React.useEffect(() => {
            if (!pickerOpen) return undefined;
            const onDown = (event) => {
              if (!pickerRef.current?.contains?.(event.target)) setPickerOpen(false);
            };
            document.addEventListener('mousedown', onDown);
            return () => document.removeEventListener('mousedown', onDown);
          }, [pickerOpen]);

          const active = pick();
          if (!active) {
            let statuses = '';
            try {
              statuses = candidates
                .map(({ ns, scope }) => `${ns}=${scope?.getSnapshot?.()?.status ?? '?'}`)
                .join(' · ');
            } catch {}
            return React.createElement(
              'div',
              { style: styles.wrap },
              React.createElement('div', null, t('unavailable')),
              React.createElement('div', { style: styles.hint }, t('fallback')),
              React.createElement('div', { style: styles.muted }, statuses),
            );
          }

          const { model, actions } = active;
          const shell = model.shell();
          const entries = parseBindings(model.field('bindings').text);
          const writable = shell.writable;

          const write = (next) => {
            actions.edit('bindings', serializeBindings(next));
            rerender();
          };

          const titleOf = (sessionId) => sessions.find((session) => session.id === sessionId)?.title ?? sessionId;

          // 已经绑定过的会话不再出现在选择列表里 —— 同一个会话只该有一条绑定
          const boundIds = new Set(entries.map((entry) => entry.sessionId));
          const pickable = sessions.filter((session) => !boundIds.has(session.id));

          const rows = entries.map((entry) =>
            React.createElement(
              'div',
              { style: styles.row, key: entry.sessionId },
              React.createElement(
                'div',
                { style: styles.sessionName, title: entry.sessionId },
                titleOf(entry.sessionId),
                React.createElement('div', { style: styles.muted }, entry.sessionId),
              ),
              React.createElement('div', { style: styles.muted }, entry.token),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: styles.button,
                  disabled: !writable,
                  onClick: () => write(entries.filter((item) => item.sessionId !== entry.sessionId)),
                },
                t('remove'),
              ),
            ),
          );

          const addRow = adding
            ? React.createElement(
                'div',
                { style: { ...styles.row, gridTemplateColumns: '1fr minmax(0, 220px) auto auto', paddingTop: 10 } },
                // 按钮 + 浮层。不用 <select>:原生弹层由浏览器绘制,不跟主题走(深色下白底白字);
                // 也不用常驻展开的列表 —— 那样会把下面的控件挤走。
                React.createElement(
                  'div',
                  { style: styles.pickerWrap, ref: pickerRef },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      style: { ...styles.input, width: '100%', textAlign: 'left', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      onClick: () => setPickerOpen((open) => !open),
                    },
                    draftSession
                      ? `${sessions.find((session) => session.id === draftSession)?.title ?? draftSession}`
                      : t('pickPlaceholder'),
                  ),
                  pickerOpen
                    ? React.createElement(
                        'div',
                        { style: styles.popover },
                        pickable.length === 0
                          ? React.createElement('div', { style: styles.muted }, t('noSessions'))
                          : pickable.map((session) =>
                              React.createElement(
                                'button',
                                {
                                  type: 'button',
                                  key: session.id,
                                  title: session.id,
                                  style: {
                                    ...styles.pickerItem,
                                    background: draftSession === session.id ? TOKEN.selectedBg : 'transparent',
                                  },
                                  onClick: () => {
                                    setDraftSession(session.id);
                                    setPickerOpen(false);
                                  },
                                },
                                `${session.title}${session.cwd ? ` · ${session.cwd}` : ''}`,
                              ),
                            ),
                      )
                    : null,
                ),
                React.createElement('input', {
                  style: styles.input,
                  placeholder: t('tokenPlaceholder'),
                  value: draftToken,
                  onChange: (event) => setDraftToken(event.target.value),
                }),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: styles.button,
                    disabled: !draftSession || !draftToken.trim(),
                    onClick: () => {
                      write([...entries.filter((item) => item.sessionId !== draftSession), { sessionId: draftSession, token: draftToken.trim() }]);
                      setAdding(false);
                      setPickerOpen(false);
                      setDraftSession('');
                      setDraftToken('');
                    },
                  },
                  t('confirm'),
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: styles.button,
                    onClick: () => {
                      setAdding(false);
                      setPickerOpen(false);
                      setDraftSession('');
                      setDraftToken('');
                    },
                  },
                  t('cancel'),
                ),
              )
            : null;

          const bindingsBlock = React.createElement(
            'div',
            { style: styles.wrap },
            React.createElement('div', { style: styles.head }, t('bindingsTitle')),
            React.createElement('div', { style: styles.hint }, t('bindingsHint')),
            ...rows,
            entries.length === 0 ? React.createElement('div', { style: styles.hint }, t('empty')) : null,
            addRow,
            adding
              ? null
              : React.createElement(
                  'div',
                  null,
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      style: styles.button,
                      disabled: !writable || pickable.length === 0,
                      onClick: () => setAdding(true),
                    },
                    `+ ${t('add')}`,
                  ),
                  pickable.length === 0 ? React.createElement('span', { style: { ...styles.muted, marginLeft: 8 } }, t('allBound')) : null,
                ),
          );

          const labels = {
            unavailable: t('unavailable'),
            readOnly: t('readOnly'),
            saveFailed: t('saveFailed'),
            save: t('save'),
            saving: t('saving'),
          };

          const portField = React.createElement(SettingsValueField, {
            id: 'code-tutor-port',
            label: t('port'),
            hint: t('portHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            numeric: true,
            invalidLabel: t('invalidNumber'),
            disabled: !writable,
            ...model.field('port'),
            onEdit: (text) => {
              actions.edit('port', text);
              rerender();
            },
            onReset: () => {
              actions.resetField('port');
              rerender();
            },
          });

          return React.createElement(
            SettingsForm,
            {
              labels,
              state: shell,
              onSave: () => {
                void actions.save();
                rerender();
              },
              onDiscard: () => {
                actions.discard();
                rerender();
              },
            },
            portField,
            bindingsBlock,
          );
        };
      } catch (error) {
        ctx.logger?.warn?.(`[code-tutor] 设置表单构建失败,退到只读页:${error?.message ?? error}`);
        return undefined;
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(LOCALE_NS);
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'code-tutor:dictionary');

        const Page = buildFormPage(ctx, t) ?? fallbackPage(t);

        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'code-tutor',
                  order: 100,
                  label: () => t('title'),
                },
                Page,
              ),
            ),
          'code-tutor:page',
        );
      },
    };
  },
});
