// Publish project specific data
(function() {
rh = window.rh;
model = rh.model;

rh.consts('DEFAULT_TOPIC', encodeURI("#Goods_and_Services_Tax_FAQ_Tutorial_Pipepline.htm".substring(1)));
rh.consts('HOME_FILEPATH', encodeURI("index.htm"));
rh.consts('START_FILEPATH', encodeURI('index.htm'));
rh.consts('HELP_ID', '389D7330-A079-4A60-ADDF-EE68A5642552' || 'preview');
rh.consts('LNG_STOP_WORDS', ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "after", "all", "along", "already", "also", "am", "among", "an", "and", "another", "any", "are", "at", "be", "because", "been", "between", "but", "by", "can", "do", "does", "doesn", "done", "each", "either", "for", "from", "get", "has", "have", "here", "how", "i", "if", "in", "into", "is", "isn", "it", "like", "may", "maybe", "more", "must", "need", "non", "not", "of", "ok", "okay", "on", "or", "other", "rather", "re", "s", "same", "see", "so", "some", "such", "t", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too", "unless", "use", "used", "using", "ve", "want", "was", "way", "were", "what", "when", "when", "whenever", "where", "whether", "which", "will", "with", "within", "without", "yet", "you", "your"]);
rh.consts('LNG_SUBSTR_SEARCH', 0);

model.publish(rh.consts('KEY_DIR'), "ltr");
model.publish(rh.consts('KEY_LNG_NAME'), "en_US");
model.publish(rh.consts('KEY_LNG'), {"Reset":"Reset","SearchResultsPerScreen":"Search results per page","SyncToc":"SyncToc","HomeButton":"Home","WebSearchButton":"WebSearch","ApplyTip":"Apply","HighlightSearchResults":"Highlight Search Results","GlossaryFilterTerms":"Filter Terms","WebSearch":"WebSearch","Show":"Show","EnableAndSearch":"Display results with all search words","ShowAll":"All","Next":"Next","Print":"Print","NoScriptErrorMsg":"Enable JavaScript support in the browser to view this page.","PreviousLabel":"Previous","Hide":"Hide","Search":"-Search-","Contents":"Contents","ShowHide":"Show/Hide","Canceled":"Canceled","EndOfResults":"End of search results.","Loading":"Loading...","SidebarToggleTip":"Expand/Collapse","ContentFilterChanged":"Content filter is changed, search again","Logo":"Logo","Logo/Author":"Powered By","JS_alert_LoadXmlFailed":"Failed to load XML file","SearchTitle":"Search","Searching":"Searching...","Disabled Next":">>","Cancel":"Cancel","JS_alert_InitDatabaseFailed":"Failed to initialize database","ResultsFoundText":"%1 result(s) found for %2","UnknownError":"Unknown error","Seperate":"|","Index":"Index","TopicsNotFound":"No results found","SearchPageTitle":"Search Results","Glossary":"Glossary","Filter":"Filter","HideAll":"Hide All","TableOfContents":"Table of Contents","NextLabel":"Next","Disabled Prev":"<<","Back":"Back","SearchOptions":"Search Options","OpenLinkInNewTab":"Open in new tab","Prev":"Previous","ToTopTip":"Go to top","NavTip":"Menu","IeCompatibilityErrorMsg":"This page cannot be viewed in Internet Explorer 8 or earlier version.","IndexFilterKewords":"Filter Keywords","JS_alert_InvalidExpression_1":"The search string you typed is not valid."});

model.publish(rh.consts('KEY_HEADER_DEFAULT_TITLE_COLOR'), "#ffffff");
model.publish(rh.consts('KEY_HEADER_DEFAULT_BACKGROUND_COLOR'), "#025172");
model.publish(rh.consts('KEY_LAYOUT_DEFAULT_FONT_FAMILY'), "\"Trebuchet MS\", Arial, sans-serif");

model.publish(rh.consts('KEY_HEADER_TITLE'), "Goods and Services Tax");
model.publish(rh.consts('KEY_HEADER_TITLE_COLOR'), "");
model.publish(rh.consts('KEY_HEADER_BACKGROUND_COLOR'), "");
model.publish(rh.consts('KEY_HEADER_LOGO_PATH'), "");
model.publish(rh.consts('KEY_LAYOUT_FONT_FAMILY'), "");
model.publish(rh.consts('KEY_HEADER_HTML'), "<div class='topic-header' onClick='rh._.goToFullLayout()'>\
  <div class='logo'>\
    <img src='#{logo}' />\
  </div>\
  <div class='nav'>\
    <div class='title' title='#{title}'>\
      <span>#{title}</span>\
    </div>\
    <div class='gotohome' title='#{tooltip}'>\
      <span>#{label}</span>\
    </div></div>\
  </div>\
<div class='topic-header-shadow'></div>\
");
model.publish(rh.consts('KEY_HEADER_CSS'), ".topic-header { background-color: #{background-color}; color: #{color}; width: calc(100%); height: 3em; position: fixed; left: 0; top: 0; font-family: #{font-family}; display: table; box-sizing: border-box; }\
.topic-header-shadow { height: 3em; width: 100%; }\
.logo { cursor: pointer; padding: 0.2em; text-align: center; display: table-cell; vertical-align: middle; }\
.logo img { width: 1.875em; display: block; }\
.nav { width: 100%; display: table-cell; }\
.title { width: 40%; height: 100%; float: left; line-height: 3em; cursor: pointer; }\
.gotohome { width: 60%; float: left; text-align: right; height: 100%; line-height: 3em; cursor: pointer; }\
.title span, .gotohome span { padding: 0em 1em; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; display: block; }");

})();