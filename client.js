/**
 * 设置页的客户端半 —— 在设置左侧导航里加一个独立页。
 *
 * 为什么必须有这一半:Host 只导出 Config schema 不会自动生成页面。
 * 设置里的每一页(费用、快照、状态文案、语音模式……)都是插件自己的客户端模块
 * 注册进 `settings.section` 槽渲染的,没有它就什么都没有。
 *
 * 这一版做了容错:表单构建失败时退化成"只读说明页",而不是整块消失 ——
 * 消失时用户和开发者都看不到任何线索,那是最难查的状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-code-tutor',
  factory(require) {
    const React = require('react');

    /**
     * 设置命名空间候选。
     *
     * patch 里的 row id 是 `dsh-agent-code-tutor`,而 Host 侧的 loader 入口 id
     * 是 `include:dsh-agent-code-tutor` —— 这两者到底哪个是"设置命名空间",
     * 取决于 configForms 的实现。两个都试,哪个 ready 用哪个,别猜。
     */
    const SETTINGS_NS_CANDIDATES = ['dsh-agent-code-tutor', 'include:dsh-agent-code-tutor'];
    /** 本页自己的文案命名空间。 */
    const LOCALE_NS = 'settings.codeTutor';

    const zh = {
      title: '编辑器陪读',
      description: '让 agent 看见并修改你的编辑器',
      port: '端口',
      portHint: 'VS Code 扩展监听的端口,要和编辑器设置 tutorApi.port 一致。默认 41890。',
      token: '会话 token',
      tokenHint: '要和编辑器工作区设置 tutorApi.conversationToken 一致。留空则自动从工作区里找。',
      unavailable: '这个页面暂时拿不到配置(设置服务不可用)。',
      fallback: '当前可以在插件目录下的 config.json 里改 port / token,或设置环境变量 EDITOR_API_PORT / EDITOR_API_TOKEN。',
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
      description: 'Let the agent see and edit your editor',
      port: 'Port',
      portHint: 'The port the VS Code extension listens on. Must match the editor setting tutorApi.port. Default 41890.',
      token: 'Session token',
      tokenHint: 'Must match the editor setting tutorApi.conversationToken. Empty discovers it from the workspace.',
      unavailable: 'This page cannot read its configuration right now (settings service unavailable).',
      fallback: 'For now edit port / token in the plugin directory config.json, or set EDITOR_API_PORT / EDITOR_API_TOKEN.',
      readOnly: 'Read only',
      saveFailed: 'Save failed',
      save: 'Save',
      saving: 'Saving…',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidNumber: 'Expected a number',
    };

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

    /**
     * 构建真正的表单页。
     *
     * 任何一步对不上(设置服务缺失、表单模型 API 变化)都返回 undefined,
     * 由调用方退到 fallbackPage。
     */
    function buildFormPage(ctx, t) {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const { SettingsFormModel, SettingsForm, SettingsValueField, settingsNumberField, settingsTextField } = primitives;
        const configForms = ctx.get?.('configForms');
        if (!configForms || typeof configForms.get !== 'function') return undefined;

        const candidates = SETTINGS_NS_CANDIDATES.map((ns) => {
          const scope = configForms.get(ns);
          const model = new SettingsFormModel(scope, [settingsNumberField('port'), settingsTextField('token')]);
          return { ns, scope, model, actions: model.actions() };
        });
        ctx.effect(() => () => candidates.forEach(({ model }) => model.dispose()), 'code-tutor:forms');

        /** 取第一个 status 为 ready 的命名空间;都没有就返回 undefined。 */
        const pick = () => {
          for (const item of candidates) {
            try {
              if (item.model.shell().available) return item;
            } catch {}
          }
          return undefined;
        };

        /**
         * 直接读 model,不用 bind() 出来的 store。
         *
         * bind() 的更新时机依赖它内部那套 observable,试过读不到值;
         * 而 shell()/field() 永远是当前真相 —— 只要在改动后自己触发一次重渲染。
         */
        return function SettingsPage() {
          const [, bump] = React.useState(0);
          const rerender = () => bump((value) => value + 1);

          React.useEffect(() => {
            const unsubscribers = candidates
              .map(({ scope }) => (typeof scope?.subscribe === 'function' ? scope.subscribe(() => rerender()) : undefined))
              .filter(Boolean);
            return () => unsubscribers.forEach((fn) => fn());
          }, []);

          const active = pick();
          if (!active) {
            // 把实际状态写出来,省得下次再猜
            let statuses = '';
            try {
              statuses = candidates
                .map(({ ns, scope }) => `${ns}=${scope?.getSnapshot?.()?.status ?? '?'}`)
                .join(' · ');
            } catch {}
            return React.createElement(
              'div',
              { style: { display: 'grid', gap: 8, fontSize: 13 } },
              React.createElement('div', null, t('unavailable')),
              React.createElement('div', { style: { opacity: 0.7, lineHeight: 1.6 } }, t('fallback')),
              React.createElement('div', { style: { opacity: 0.45, fontSize: 11 } }, statuses),
            );
          }

          const model = active.model;
          const actions = active.actions;
          let shell;
          try {
            shell = model.shell();
          } catch (error) {
            return React.createElement('div', { style: { opacity: 0.7 } }, t('unavailable'));
          }

          const state = {
            ...shell,
            port: model.field('port'),
            token: model.field('token'),
          };

          const labels = {
            unavailable: t('unavailable'),
            readOnly: t('readOnly'),
            saveFailed: t('saveFailed'),
            save: t('save'),
            saving: t('saving'),
          };

          const field = (name, label, hint, numeric) =>
            React.createElement(SettingsValueField, {
              id: `code-tutor-${name}`,
              label,
              hint,
              overriddenLabel: t('overridden'),
              resetLabel: t('reset'),
              ...(numeric ? { numeric: true, invalidLabel: t('invalidNumber') } : {}),
              disabled: !state.writable,
              ...state[name],
              onEdit: (text) => {
                actions.edit(name, text);
                rerender();
              },
              onReset: () => {
                actions.resetField(name);
                rerender();
              },
            });

          return React.createElement(
            SettingsForm,
            {
              labels,
              state,
              onSave: () => {
                void actions.save();
                rerender();
              },
              onDiscard: () => {
                actions.discard();
                rerender();
              },
            },
            field('port', t('port'), t('portHint'), true),
            field('token', t('token'), t('tokenHint'), false),
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
