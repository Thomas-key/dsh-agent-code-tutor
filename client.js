/**
 * 设置页的客户端半 —— 往「插件」页里加一张配置卡片。
 *
 * 为什么必须有这一半:Host 只导出 Config schema 是不够的 —— 设置页的每一页
 * 都是插件自己的客户端模块注册进 `plugins.item` 槽渲染的,没有它就什么都不显示。
 *
 * 卡片只在 Host 真的提供这个命名空间时才注册(`configForms.whileServed`),
 * 所以卸载插件后不会留下空壳。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-code-tutor',
  factory(require) {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { SettingsFormModel, SettingsForm, SettingsValueField, settingsNumberField, settingsTextField } = primitives;

    /** 和 cordis.patch.yml 里的 row id 一致 —— 设置命名空间就是它。 */
    const SETTINGS_NS = 'dsh-agent-code-tutor';
    /** 本页自己的文案命名空间。 */
    const LOCALE_NS = 'settings.codeTutor';

    const zh = {
      title: '编辑器陪读',
      description: '让 agent 看见并修改你的编辑器:指着代码讲、一小段一小段写,写完交还给你。',
      port: '端口',
      portHint: 'VS Code 扩展监听的端口,要和编辑器设置 tutorApi.port 一致。默认 41890。',
      token: '会话 token',
      tokenHint: '要和编辑器工作区设置 tutorApi.conversationToken 一致。留空则自动从工作区里找。',
      unavailable: '暂不可用',
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
      description: 'Let the agent see and edit your editor: point at code, write in small steps, and hand control back to you.',
      port: 'Port',
      portHint: 'The port the VS Code extension listens on. Must match the editor setting tutorApi.port. Default 41890.',
      token: 'Session token',
      tokenHint: 'Must match the editor setting tutorApi.conversationToken. Leave empty to discover it from the workspace.',
      unavailable: 'Unavailable',
      readOnly: 'Read only',
      saveFailed: 'Save failed',
      save: 'Save',
      saving: 'Saving…',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidNumber: 'Expected a number',
    };

    /**
     * 最小卡片:先只保证**能渲染出来**。
     *
     * 用 props.form(Host 给的配置表)优先;没有就退回静态说明。
     * 不碰任何未文档化的 hook —— 渲染抛错会让整张卡消失,那比没设置更糟。
     */
    function Card(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key;
      const view = props?.view ?? 'page';
      if (view === 'summary') return t('description');

      const form = props?.form;
      const value = form?.value ?? form?.values ?? null;
      const rows = [];

      if (value && typeof value === 'object') {
        rows.push(`端口:${value.port ?? '(默认 41890)'}`);
        rows.push(`会话 token:${value.token ? '已设置' : '(空,自动发现)'}`);
      } else {
        rows.push('当前值请看插件目录下的 config.json,或环境变量 EDITOR_API_PORT / EDITOR_API_TOKEN。');
      }

      return React.createElement(
        'div',
        { style: { padding: '10px 0', display: 'grid', gap: 6, fontSize: 13 } },
        React.createElement('div', { style: { fontWeight: 600 } }, t('title')),
        ...rows.map((line) => React.createElement('div', { key: line }, line)),
        React.createElement(
          'div',
          { style: { opacity: 0.65, fontSize: 12, lineHeight: 1.5 } },
          t('portHint'),
          ' ',
          t('tokenHint'),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(LOCALE_NS);
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'code-tutor:dictionary');

        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-agent-code-tutor',
                  locale: LOCALE_NS,
                },
                Card,
              ),
            ),
          'code-tutor:page',
        );
      },
    };
  },
});
