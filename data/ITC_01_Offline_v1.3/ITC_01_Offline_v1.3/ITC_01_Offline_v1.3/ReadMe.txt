*********************** Offline Utility Information for ITC-01 (v1.3) ***********************





*************************  Prerequisites Before Installation  *****************************

1. Windows OS 7.0 and above. System should be of 32bit or 64 bit.
2. The version of Microsoft Excel on your Computer system should be Microsoft Office Excel 2007 and above. 
3. User should have admin rights of the system.
4. A software like - WinZip or WinRAR to uncompress file




*************************       Installation        **********************************

1.After Downloading the "ITC_01_Offline_v1.3.zip" from GST Portal, extract it using WinZip in a folder.
2.Open the extracted folder and you will find a MS Excel file with name "ITC_01_Offline_v1.3.xls".
3.Double Click on it to open.
4.Once opened, click on "Enable Editing" and "Enable Macros" and/or "Enable Content" button on top.
5.Now you can use the tool.



**************************    How to Use the Tool    ************************************



Excel workbook template has 3 worksheets
Worksheet 1: Help Instructions - Contains introduction and help instructions
Worksheet 2: Import_Export_file - Import and edit existing JSON file or Generate JSON file from the data entered in Sheet.
Worksheet 3: Name of this sheet will be according to the section chosen in the Worksheet 2. By default, section 18A is chosen. Sheet Sec_18_1_A will be visible in this case. 


ITC-01 offline tool is an Excel based utility to prepare your GST ITC-01, to claim credits for Input Tax credit 

1. Please ensure you download the latest version of ITC-01 Offline Tool from the GST portal. https://www.gst.gov.in/download/returns.
2. Launch the ITC-01 Excel based Offline Tool and navigate to worksheet named 'Import_Export_file'. 
3. Enter your GSTIN . Entered GSTIN would be validated for correct structure. 
4. Select the relevant claim section from 'Claim made under' drop-down.
5. Please fill the date of registration / opt out from composition / exempt goods become taxable in the cell according to the selected claim section (18(1) a,b,c & d).
6. Enter details as applicable. In each row invoice number should be there and no rows should be left blank in between.
7. Click on 'Validate' to validate each worksheet post all details are captured for the sheet. Check the status of validation. In case of validation failure; please check for cells that have failed validation and correct errors as per help text in the column  Sheet Validation Errors .
8. Click on 'Generate summary' to update the summary post details. Ensure that details have been successfully validated for each worksheet. 
9. Click on ' Generate JSON File to Upload ' to generate JSON file for upload of ITC-01 declaration details prepared offline on GST portal
10. In case any error while validating or exporting, Last column named "Error" will also be filled with error message "This row has some error" and colored to red. User can follow red cells in corresponding column.



Important: Do not tamper with the excel template. This might generate erroneous JSON file and create problems while filing GST ITC-01




****************** Important points to note while using offline utility **************************


1.	Exporting large number of entries size will take time. Excel may show  Not responding  message on the top. Please ignore that and don t not to close the excel and wait of sometime.
2.	Please make sure to Empty the sheets before importing any file.
3.	For importing file into excel, please make sure you have selected same section as the file you want to import.
4.	While Opening the Excel sheet, if you see error message box like: "Compilation error in module due to incompatibility with the version, platform or architecture", please ignore this message and see if it works or not. In case it does not work, you need latest MS Office for successful export of your data.
5.	Please start writing data from ROW 7 and DO NOT SKIP any row. JSON creation won't read any data after any row skipped. Therefore, please fill your challan detail in continues manner 
6.	The row is valid only if there is any invoice number. File generation will not read the details after the row where, there is no invoice number in that row.  


