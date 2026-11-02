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

    /** 把 Host 侧的配置作用域桥接成这一页的分阶段表单。 */
    class CardController {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, [settingsNumberField('port'), settingsTextField('token')]);
        this.store = this.form.bind(() => this.projection());
      }

      projection() {
        return {
          ...this.form.shell(),
          port: this.form.field('port'),
          token: this.form.field('token'),
        };
      }

      /** 给槽注册用的接口:一个快照 hook + 表单动作。 */
      inject() {
        return { hooks: { codeTutorCard: this.store }, ...this.form.actions() };
      }

      dispose() {
        this.form.dispose();
      }
    }

    function Card(props) {
      const { t } = props;
      const state = props.useCodeTutorCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');

      const labels = {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      };

      const field = (name, label, hint, numeric) =>
        React.createElement(SettingsValueField, {
          id: `plugin-config-code-tutor-${name}`,
          label,
          hint,
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          ...(numeric ? { numeric: true, invalidLabel: t('invalidNumber') } : {}),
          disabled: !state.writable,
          ...state[name],
          onEdit: (text) => props.edit(name, text),
          onReset: () => props.resetField(name),
        });

      return React.createElement(
        SettingsForm,
        { labels, state, onSave: props.save, onDiscard: props.discard },
        field('port', t('port'), t('portHint'), true),
        field('token', t('token'), t('tokenHint'), false),
      );
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(LOCALE_NS);
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'code-tutor:dictionary');

        const card = new CardController(ctx.configForms.get(SETTINGS_NS));
        ctx.effect(() => () => card.dispose(), 'code-tutor:form');

        // 注册进「内置插件 → bundle 详情页」的配置区。
        // key 必须是 **bundle 包名**;注册进 plugins.item 是官方设置页专用的,不算数。
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-agent-code-tutor',
                  locale: LOCALE_NS,
                  inject: () => card.inject(),
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
