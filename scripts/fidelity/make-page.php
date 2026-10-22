<?php
// wp eval-file make-page.php <template.json>
// Imports the template through Elementor's own importer, then publishes a page built from it.
$file = $args[0];
wp_set_current_user( 1 );
$source = \Elementor\Plugin::$instance->templates_manager->get_source( 'local' );
$result = $source->import_template( basename( $file ), $file );
if ( is_wp_error( $result ) ) { fwrite( STDERR, 'IMPORT ERROR: ' . $result->get_error_message() . "\n" ); exit( 1 ); }
$tpl = $result[0];
$tpl_id = $tpl['template_id'];
$doc = \Elementor\Plugin::$instance->documents->get( $tpl_id );
$data = $doc->get_elements_data();
$settings = get_post_meta( $tpl_id, '_elementor_page_settings', true );
$page_id = wp_insert_post( [ 'post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Render ' . $tpl_id ] );
$page = \Elementor\Plugin::$instance->documents->get( $page_id );
$page->set_is_built_with_elementor( true );
$page->save( [ 'elements' => $data, 'settings' => $settings ?: [] ] );
update_post_meta( $page_id, '_wp_page_template', ( $settings['template'] ?? 'elementor_canvas' ) );
echo "\nPAGE_ID=" . $page_id . "\n";
