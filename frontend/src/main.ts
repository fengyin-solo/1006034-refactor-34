import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { migrateIfNeeded } from './data/migrations'
import './styles/global.css'

// 挂载前完成存量迁移：历史计划的缺口按统一算法回填，已下发的补记台账。
migrateIfNeeded()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
