import { Alert, AlertTitle, Button } from '@mui/material';

export function ErrorState({ message, title, onRetry }: { message: string; title?: string; onRetry?: () => void }) {
  return (
    <Alert
      severity="error"
      action={onRetry ? <Button color="inherit" size="small" onClick={onRetry}>Retry</Button> : undefined}
    >
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {message}
    </Alert>
  );
}
