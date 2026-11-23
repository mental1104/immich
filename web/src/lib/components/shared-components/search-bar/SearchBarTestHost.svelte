<script lang="ts">
  // 搜索框在真实页面中由全局TooltipProvider包裹，入口交互测试复用同样上下文。
  import SearchBar from '#lib/components/shared-components/search-bar/SearchBar.svelte';
  import { TooltipProvider } from '@immich/ui';
  import '../../../../app.css';
</script>

<TooltipProvider><SearchBar grayTheme={false} /></TooltipProvider>
