import type { Command } from 'commander';
import { getLanguage, t, zhCN, type Message } from './i18n.js';

export function parserMessage(message: string): string {
  if (getLanguage() === 'en') return message;
  return message
    .replace(/error: missing required argument '([^']*)'/g, (_, arg: string) => t("error: missing required argument '{0}'", arg))
    .replace(/error: option '([^']*)' argument missing/g, (_, option: string) => t("error: option '{0}' argument missing", option))
    .replace(/error: unknown option '([^']*)'/g, (_, option: string) => t("error: unknown option '{0}'", option))
    .replace(/error: unknown command '([^']*)'/g, (_, command: string) => t("error: unknown command '{0}'", command))
    .replace(/error: option '([^']*)' cannot be used with option '([^']*)'/g, (_, a: string, b: string) => t("error: option '{0}' cannot be used with option '{1}'", a, b))
    .replace(/error: option '([^']*)' argument '([^']*)' is invalid\./g, (_, option: string, value: string) => t("error: option '{0}' argument '{1}' is invalid.", option, value))
    .replace(/error: too many arguments(?: for '([^']*)')?\. Expected (\d+) arguments? but got (\d+)\./g,
      (_, command: string | undefined, expected: string, actual: string) => t('error: too many arguments{0}. Expected {1} argument(s) but got {2}.', command ? t(" for '{0}'", command) : '', expected, actual));
}
export function localizeCommander(program: Command): void {
  program.helpOption('-h, --help', t('display help for command'))
    .helpCommand('help [command]', t('display help for command'))
    .showSuggestionAfterError(false)
    .configureHelp({
      showGlobalOptions: true,
      styleTitle: title => Object.hasOwn(zhCN, title) ? t(title as Message) : title,
    })
    .configureOutput({ outputError: (message, write) => write(parserMessage(message)) });
}
