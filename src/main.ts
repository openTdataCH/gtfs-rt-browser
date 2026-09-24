import { bootstrapApplication } from '@angular/platform-browser';
import { registerLocaleData } from '@angular/common';
import localeDeCh from '@angular/common/locales/de-CH';
import { LOCALE_ID } from '@angular/core';
import { AppComponent } from './app/app.component';

registerLocaleData(localeDeCh);
bootstrapApplication(AppComponent, {
  providers: [{ provide: LOCALE_ID, useValue: 'de-CH' }]
}).catch((error) => console.error(error));
