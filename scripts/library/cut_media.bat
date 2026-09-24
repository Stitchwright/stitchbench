@echo off
rem Cut machine pictures and manual figures from C:\Manuals, then upload them to StitchBench's database.
rem Safe to stop and re-run: finished pictures and figures are skipped.
cd /d "%~dp0\..\.."
echo Machine pictures ...
python scripts\library\model_images.py
echo Figures (domestic, embroidery, longarm) ...
python scripts\library\render_figures.py Sewing Embroidery Longarm
echo Uploading ...
call npx tsx scripts\library\upload-media.ts
echo Done. Tell Claude "pictures are done".
pause
