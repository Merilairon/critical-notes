import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideBrowserGlobalErrorListeners, type ApplicationConfig } from '@angular/core';
import { provideRouter, TitleStrategy, withComponentInputBinding, withInMemoryScrolling, withRouterConfig } from '@angular/router';
import { routes } from './app.routes';
import { AppTitleStrategy } from './core/page-title';
import { httpInterceptor } from './core/http.interceptor';
import { PreviewCard } from './reference/preview-card';
import { PREVIEW_COMPONENT } from './reference/render/hover-preview.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withRouterConfig({ paramsInheritanceStrategy: 'always' }), withInMemoryScrolling({ scrollPositionRestoration: 'enabled' })),
    provideHttpClient(withFetch(), withInterceptors([httpInterceptor])),
    { provide: TitleStrategy, useExisting: AppTitleStrategy },
    { provide: PREVIEW_COMPONENT, useValue: PreviewCard },
  ],
};
