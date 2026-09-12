import { useTranslation } from '../../lib/i18n';
import { Spinner } from './Spinner';

export function LoadingView() {
    const { t } = useTranslation();
    return (
        <div className="preview-panel__empty" role="status">
            <Spinner />
            <span>{t('common.loading')}</span>
        </div>
    );
}
